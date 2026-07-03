<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { CidrEntry } from '../lib/geodata/geoip';
import { looksLikeIp } from '../lib/geodata/geoip';
import type { DomainEntry } from '../lib/geodata/geosite';
import { GeodataClient, type ProgressStage } from '../lib/geodata/workerClient';

const PAGE_SIZE = 100;

const activeTab = ref<'lookup' | 'browse'>('lookup');
const progress = ref<Record<'geosite' | 'geoip', ProgressStage | 'idle'>>({ geosite: 'idle', geoip: 'idle' });

let client: GeodataClient | null = null;

onMounted(() => {
  client = new GeodataClient();
  client.onProgress((p) => {
    progress.value = { ...progress.value, [p.kind]: p.stage };
  });
});

onUnmounted(() => {
  client?.terminate();
});

// --- Lookup tab: domain or IP -> matching rule names ---
const lookupInput = ref('');
const lookupLoading = ref(false);
const lookupError = ref<string | null>(null);
const lookupResults = ref<string[] | null>(null);
const lookupKind = computed<'ip' | 'domain'>(() => (looksLikeIp(lookupInput.value.trim()) ? 'ip' : 'domain'));

async function runLookup() {
  const input = lookupInput.value.trim();
  if (!input || !client) return;
  lookupLoading.value = true;
  lookupError.value = null;
  lookupResults.value = null;
  try {
    lookupResults.value = lookupKind.value === 'ip' ? await client.matchIp(input) : await client.matchDomain(input);
  } catch (err) {
    lookupError.value = err instanceof Error ? err.message : String(err);
  } finally {
    lookupLoading.value = false;
  }
}

// --- Browse tab: rule name -> pattern/CIDR list ---
const browseSource = ref<'geosite' | 'geoip'>('geosite');
const categories = ref<string[]>([]);
const categoriesLoading = ref(false);
const categoryFilter = ref('');
const selectedCategory = ref('');
const browseItems = ref<DomainEntry[] | CidrEntry[]>([]);
const browseLoading = ref(false);
const browseError = ref<string | null>(null);
const page = ref(1);

const filteredCategories = computed(() => {
  const q = categoryFilter.value.trim().toLowerCase();
  if (!q) return categories.value;
  return categories.value.filter((c) => c.includes(q));
});

const totalPages = computed(() => Math.max(1, Math.ceil(browseItems.value.length / PAGE_SIZE)));
const pagedItems = computed(() => browseItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

async function loadCategories() {
  if (!client) return;
  categories.value = [];
  selectedCategory.value = '';
  browseItems.value = [];
  categoriesLoading.value = true;
  try {
    categories.value = browseSource.value === 'geosite' ? await client.listGeoSiteCategories() : await client.listGeoIpCategories();
  } finally {
    categoriesLoading.value = false;
  }
}

async function selectCategory(category: string) {
  if (!client) return;
  selectedCategory.value = category;
  page.value = 1;
  browseLoading.value = true;
  browseError.value = null;
  try {
    browseItems.value = browseSource.value === 'geosite' ? await client.getCategoryDomains(category) : await client.getCategoryCidrs(category);
  } catch (err) {
    browseError.value = err instanceof Error ? err.message : String(err);
  } finally {
    browseLoading.value = false;
  }
}

function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join('.');
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    groups.push((((bytes[i] << 8) | bytes[i + 1]) >>> 0).toString(16));
  }
  return groups.join(':');
}

function isCidrEntry(item: DomainEntry | CidrEntry): item is CidrEntry {
  return browseSource.value === 'geoip';
}
</script>

<template>
  <div class="tool">
    <nav class="tabs">
      <button type="button" :class="{ active: activeTab === 'lookup' }" @click="activeTab = 'lookup'">域名 / IP 查询</button>
      <button type="button" :class="{ active: activeTab === 'browse' }" @click="activeTab = 'browse'">规则名查询</button>
    </nav>

    <section v-if="activeTab === 'lookup'" class="panel">
      <form @submit.prevent="runLookup">
        <input v-model="lookupInput" type="text" placeholder="输入域名或 IP，例如 google.com 或 8.8.8.8" />
        <button type="submit" :disabled="lookupLoading || !lookupInput.trim()">查询</button>
      </form>
      <p class="hint">识别为：{{ lookupKind === 'ip' ? 'IP 地址（查询 geoip.dat）' : '域名（查询 geosite.dat）' }}</p>
      <p class="progress" v-if="progress[lookupKind === 'ip' ? 'geoip' : 'geosite'] !== 'ready' && lookupLoading">
        {{ { downloading: '正在下载数据文件…', parsing: '正在解析数据…', idle: '' }[progress[lookupKind === 'ip' ? 'geoip' : 'geosite']] }}
      </p>
      <p v-if="lookupError" class="error">{{ lookupError }}</p>
      <div v-if="lookupResults">
        <p v-if="lookupResults.length === 0">未命中任何规则。</p>
        <ul v-else class="tag-list">
          <li v-for="rule in lookupResults" :key="rule">{{ rule }}</li>
        </ul>
      </div>
    </section>

    <section v-else class="panel">
      <div class="browse-controls">
        <label><input type="radio" value="geosite" v-model="browseSource" @change="loadCategories" /> geosite（域名规则）</label>
        <label><input type="radio" value="geoip" v-model="browseSource" @change="loadCategories" /> geoip（IP 规则）</label>
        <button type="button" @click="loadCategories" :disabled="categoriesLoading">
          {{ categories.length ? '重新加载规则列表' : '加载规则列表' }}
        </button>
      </div>
      <p class="progress" v-if="categoriesLoading">正在下载并解析 {{ browseSource === 'geosite' ? 'geosite.dat' : 'geoip.dat' }}…</p>

      <div v-if="categories.length" class="browse-body">
        <input v-model="categoryFilter" type="text" placeholder="筛选规则名…" />
        <select v-model="selectedCategory" @change="selectCategory(selectedCategory)" size="8">
          <option v-for="c in filteredCategories" :key="c" :value="c">{{ c }}</option>
        </select>

        <div v-if="browseLoading">加载中…</div>
        <p v-else-if="browseError" class="error">{{ browseError }}</p>
        <div v-else-if="selectedCategory">
          <p>{{ selectedCategory }} 共 {{ browseItems.length }} 条，第 {{ page }} / {{ totalPages }} 页</p>
          <ul class="entry-list">
            <li v-for="(item, i) in pagedItems" :key="i">
              <template v-if="isCidrEntry(item)">{{ formatIp(item.ip) }}/{{ item.prefix }}</template>
              <template v-else>[{{ item.type }}] {{ item.value }}</template>
            </li>
          </ul>
          <div class="pager">
            <button type="button" :disabled="page <= 1" @click="page--">上一页</button>
            <button type="button" :disabled="page >= totalPages" @click="page++">下一页</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tool {
  max-width: 720px;
  margin: 2rem auto;
  font-family: system-ui, sans-serif;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.tabs button {
  padding: 0.5rem 1rem;
  border: 1px solid #ccc;
  background: #f5f5f5;
  cursor: pointer;
}
.tabs button.active {
  background: #333;
  color: #fff;
}
.panel form {
  display: flex;
  gap: 0.5rem;
}
input[type='text'] {
  flex: 1;
  padding: 0.4rem;
}
button {
  padding: 0.4rem 0.8rem;
}
.hint {
  color: #666;
  font-size: 0.9rem;
}
.progress {
  color: #666;
}
.error {
  color: #c00;
}
.tag-list {
  list-style: none;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.tag-list li {
  background: #eee;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
}
.browse-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}
.browse-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
select {
  width: 100%;
}
.entry-list {
  max-height: 320px;
  overflow-y: auto;
  font-family: monospace;
}
.pager {
  display: flex;
  gap: 0.5rem;
}
</style>
