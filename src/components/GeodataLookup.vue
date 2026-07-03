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
  if (blurTimeoutId !== undefined) window.clearTimeout(blurTimeoutId);
});

// --- Lookup tab: domain or IP -> matching rule names ---
const lookupInput = ref('');
const lookupLoading = ref(false);
const lookupError = ref<string | null>(null);
const lookupResults = ref<string[] | null>(null);
const lookupKind = computed<'ip' | 'domain'>(() => (looksLikeIp(lookupInput.value.trim()) ? 'ip' : 'domain'));
// Captured at query time so a later edit to lookupInput can't change which
// source (geosite/geoip) a previously-shown result belongs to.
const lastLookupKind = ref<'ip' | 'domain'>('domain');

async function runLookup() {
  const input = lookupInput.value.trim();
  if (!input || !client) return;
  lastLookupKind.value = lookupKind.value;
  lookupLoading.value = true;
  lookupError.value = null;
  lookupResults.value = null;
  try {
    lookupResults.value = lastLookupKind.value === 'ip' ? await client.matchIp(input) : await client.matchDomain(input);
  } catch (err) {
    lookupError.value = err instanceof Error ? err.message : String(err);
  } finally {
    lookupLoading.value = false;
  }
}

// --- Browse tab: rule name -> pattern/CIDR list, searched across both sources at once ---
type RuleSource = 'geosite' | 'geoip';

const geoSiteCategories = ref<string[]>([]);
const geoIpCategories = ref<string[]>([]);
let categoriesLoadStarted = false;

function ensureCategoriesLoaded() {
  if (categoriesLoadStarted || !client) return;
  categoriesLoadStarted = true;
  client.listGeoSiteCategories().then((list) => (geoSiteCategories.value = list));
  client.listGeoIpCategories().then((list) => (geoIpCategories.value = list));
}

const loadingHint = computed(() => {
  const parts: string[] = [];
  if (progress.value.geosite === 'downloading' || progress.value.geosite === 'parsing') parts.push('geosite.dat');
  if (progress.value.geoip === 'downloading' || progress.value.geoip === 'parsing') parts.push('geoip.dat');
  return parts.length ? `正在下载并解析 ${parts.join(' 和 ')}…` : '';
});

const ruleQuery = ref('');
const showDropdown = ref(false);
let blurTimeoutId: ReturnType<typeof window.setTimeout> | undefined;

function handleRuleInputFocus() {
  // Cancel a pending close from a previous blur so a quick refocus (or a
  // click that steals focus then immediately returns it) can't have the
  // dropdown yanked shut out from under it.
  if (blurTimeoutId !== undefined) {
    window.clearTimeout(blurTimeoutId);
    blurTimeoutId = undefined;
  }
  showDropdown.value = true;
  ensureCategoriesLoaded();
}

// Delayed so a click (or Enter on a keyboard-focused suggestion) has time to
// register before the dropdown unmounts; blurring straight away would close
// it first and swallow the selection.
function handleRuleInputBlur() {
  blurTimeoutId = window.setTimeout(() => {
    showDropdown.value = false;
    blurTimeoutId = undefined;
  }, 150);
}

const selectedRule = ref<{ name: string; source: RuleSource } | null>(null);
const browseItems = ref<DomainEntry[] | CidrEntry[]>([]);
const browseLoading = ref(false);
const browseError = ref<string | null>(null);
const page = ref(1);

const SUGGESTIONS_PER_SOURCE = 25;

// Ranks exact match first, then prefix matches, then substring matches, so a
// small source (e.g. geoip's ~250 categories) isn't crowded out of a shared
// cap by a much larger one (geosite's ~1500).
function rankMatches(list: string[], q: string): string[] {
  return list
    .filter((name) => name.includes(q))
    .sort((a, b) => {
      const rank = (name: string) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .slice(0, SUGGESTIONS_PER_SOURCE);
}

const filteredSuggestions = computed(() => {
  const q = ruleQuery.value.trim().toLowerCase();
  if (!q) return [];
  const ipMatches = rankMatches(geoIpCategories.value, q).map((name) => ({ name, source: 'geoip' as const }));
  const siteMatches = rankMatches(geoSiteCategories.value, q).map((name) => ({ name, source: 'geosite' as const }));
  return [...ipMatches, ...siteMatches];
});

function selectFirstSuggestion() {
  const first = filteredSuggestions.value[0];
  if (first) selectRule(first.name, first.source);
}

const totalPages = computed(() => Math.max(1, Math.ceil(browseItems.value.length / PAGE_SIZE)));
const pagedItems = computed(() => browseItems.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

async function selectRule(name: string, source: RuleSource) {
  if (!client) return;
  ensureCategoriesLoaded();
  selectedRule.value = { name, source };
  ruleQuery.value = name;
  showDropdown.value = false;
  page.value = 1;
  browseLoading.value = true;
  browseError.value = null;
  try {
    browseItems.value = source === 'geosite' ? await client.getCategoryDomains(name) : await client.getCategoryCidrs(name);
  } catch (err) {
    browseError.value = err instanceof Error ? err.message : String(err);
  } finally {
    browseLoading.value = false;
  }
}

function goToRule(rule: string) {
  const source: RuleSource = lastLookupKind.value === 'ip' ? 'geoip' : 'geosite';
  activeTab.value = 'browse';
  selectRule(rule, source);
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
  return selectedRule.value?.source === 'geoip';
}
</script>

<template>
  <div class="tool">
    <nav class="tabs">
      <button type="button" :class="{ active: activeTab === 'lookup' }" @click="activeTab = 'lookup'">域名 / IP 查询</button>
      <button type="button" :class="{ active: activeTab === 'browse' }" @click="activeTab = 'browse'; ensureCategoriesLoaded()">规则名查询</button>
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
          <li v-for="rule in lookupResults" :key="rule">
            <button type="button" class="tag-button" @click="goToRule(rule)">{{ rule }}</button>
          </li>
        </ul>
      </div>
    </section>

    <section v-else class="panel">
      <div class="rule-search">
        <input
          v-model="ruleQuery"
          type="text"
          autocomplete="off"
          placeholder="输入规则名，例如 google、cn…（同时搜索 geosite 与 geoip）"
          @focus="handleRuleInputFocus"
          @blur="handleRuleInputBlur"
          @input="showDropdown = true"
          @keydown.enter.prevent="selectFirstSuggestion"
        />
        <ul v-if="showDropdown && filteredSuggestions.length" class="suggestions">
          <li v-for="s in filteredSuggestions" :key="`${s.source}:${s.name}`">
            <button type="button" @click="selectRule(s.name, s.source)">
              {{ s.name }} <span class="source-tag">{{ s.source }}</span>
            </button>
          </li>
        </ul>
      </div>
      <p class="progress" v-if="loadingHint">{{ loadingHint }}</p>

      <div v-if="browseLoading">加载中…</div>
      <p v-else-if="browseError" class="error">{{ browseError }}</p>
      <div v-else-if="selectedRule">
        <p>{{ selectedRule.name }}（{{ selectedRule.source }}）共 {{ browseItems.length }} 条，第 {{ page }} / {{ totalPages }} 页</p>
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
.tag-button {
  background: #eee;
  border: none;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
}
.tag-button:hover {
  background: #ddd;
}
.rule-search {
  position: relative;
  margin-bottom: 0.5rem;
}
.rule-search input {
  width: 100%;
}
.suggestions {
  position: absolute;
  z-index: 1;
  top: 100%;
  left: 0;
  right: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #ccc;
  border-top: none;
}
.suggestions li button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border: none;
  background: none;
  cursor: pointer;
}
.suggestions li button:hover {
  background: #eee;
}
.source-tag {
  color: #888;
  font-size: 0.8rem;
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
