<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { canViewDoc } from '@/utils/permission'
import { extractKeywords, scoreDoc } from '@/utils/qa'
import { stripHtml, highlightText, highlightTitle, extractSnippet } from '@/utils/search'
import { formatDate } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()

const question = ref('')
const asked = ref('')
const thinking = ref(false)
const answered = ref(false)
const answer = ref('')
const cites = ref([])
const related = ref([])
const suggestions = ['Vue 如何初始化项目?', 'Dexie 怎么进行查询?', '权限模型里有哪些角色?', '新成员入职流程是什么?']

async function ask(raw) {
  const qtext = (raw ?? question.value).trim()
  if (!qtext) return
  asked.value = qtext
  answering()
}

function answering() {
  thinking.value = true
  answered.value = false
  answer.value = ''
  cites.value = []
  related.value = []

  setTimeout(() => {
    const keywords = extractKeywords(asked.value)
    const tagNames = kb.tags
    const hits = kb.docs.filter((d) => canViewDoc(d, auth.user?.id)).map((d) => ({
      doc: d,
      bodyText: stripHtml(d.body),
      score: scoreDoc(d, keywords, tagNames, stripHtml(d.body))
    })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)

    const top = hits[0]
    if (!top) {
      answered.value = true
      answer.value = '很抱歉，知识库中暂时没有与「' + asked.value + '」直接匹配的内容。建议你换一种表述，或浏览文档库 / 使用全局搜索。'
      return
    }

    answer.value = '基于知识库检索，我找到与「' + asked.value + '」相关的内容，引用来源如下。' + (hits.length > 1 ? ' 我对其归纳后优先展示最相关的 ' + Math.min(hits.length, 3) + ' 篇文档。' : '')
    cites.value = hits.slice(0, 3).map((h) => ({
      ...h.doc,
      bodyText: h.bodyText,
      snippet: extractSnippet(h.doc.body, keywords),
      score: h.score
    }))
    related.value = hits.slice(3, 7).map((h) => h.doc)
    thinking.value = false
    answered.value = true
  }, 600)
}

function useSuggestion(s) { question.value = s; ask(s) }

watch(() => route.query.q, (v) => { if (v) { question.value = v; ask(v) } }, { immediate: true })
</script>

<template>
  <div class="qa-page">
    <header class="head">
      <div class="title-line"><h2>🤖 智能知识问答</h2><span class="pill">基于规则检索 · mock 演示</span></div>
      <p class="sub">向整个知识库提问，AI 助手会检索相关内容并给出引用出处与相关条目。</p>
      <div class="ask-box">
        <input v-model="question" placeholder="例如：Vue 如何初始化项目？" @keyup.enter="ask()" />
        <button class="btn primary" :disabled="!question.trim()" @click="ask()">提问</button>
      </div>
      <div class="sug">
        <span v-for="s in suggestions" :key="s" class="sug-item" @click="useSuggestion(s)">{{ s }}</span>
      </div>
    </header>

    <div v-if="thinking" class="card thinking">🤔 正在检索知识库，关联相关条目…</div>

    <div v-if="answered" class="answer card">
      <div class="a-label">助手回答<span class="sub-ask">问题：{{ asked }}</span></div>
      <p class="a-text">{{ answer }}</p>

      <div v-if="cites.length" class="cites">
        <div class="block-title">📎 引用出处</div>
        <div v-for="c in cites" :key="c.id" class="cite" @click="router.push('/docs/' + c.id)">
          <div class="cite-head">
            <span class="cite-score" v-if="c.score >= 5">★ 高相关</span>
            <span class="cite-title" v-html="highlightTitle(c.title, extractKeywords(asked))"></span>
          </div>
          <div class="cite-snippet" v-html="highlightText(c.snippet, extractKeywords(asked))"></div>
          <div class="cite-meta">分类 · {{ kb.catMap[c.categoryId]?.name }} · 更新于 {{ formatDate(c.updatedAt) }}</div>
        </div>
      </div>

      <div v-if="related.length" class="related">
        <div class="block-title">🧩 相关条目</div>
        <div v-for="r in related" :key="r.id" class="rel" @click="router.push('/docs/' + r.id)">
          <span class="rel-title">{{ r.title }}</span>
          <span class="rel-tag">{{ kb.catMap[r.categoryId]?.name }}</span>
        </div>
      </div>
    </div>

    <div v-else-if="!thinking" class="empty card"><div class="ico">💬</div>输入问题开始提问</div>
  </div>
</template>

<style scoped>
.qa-page { max-width: 780px; margin: 0 auto; }
.head .title-line { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.head h2 { margin: 0; }
.sub { color: var(--text-2); }
.ask-box { display: flex; gap: 10px; margin: 14px 0; }
.ask-box input { flex: 1; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; }
.ask-box input:focus { border-color: var(--primary); }
.sug { display: flex; flex-wrap: wrap; gap: 8px; }
.sug-item { padding: 4px 12px; border: 1px dashed var(--border); border-radius: 999px; font-size: 12px; color: var(--text-2); cursor: pointer; }
.sug-item:hover { border-color: var(--primary); color: var(--primary); }
.thinking { padding: 24px; color: var(--text-2); display: flex; align-items: center; gap: 10px; }
.answer { margin-top: 16px; padding: 24px 28px; }
.a-label { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; }
.sub-ask { font-weight: 400; font-size: 12px; color: var(--text-3); }
.a-text { margin: 8px 0 18px; color: var(--text); }
.block-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin: 16px 0 10px; }
.cites { display: flex; flex-direction: column; gap: 10px; }
.cite { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; cursor: pointer; }
.cite:hover { border-color: var(--primary); }
.cite-head { display: flex; align-items: center; gap: 8px; }
.cite-score { background: var(--primary-weak); color: var(--primary); font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.cite-title { font-weight: 700; }
.cite-snippet { color: var(--text-2); font-size: 13px; margin: 6px 0; }
.cite-meta { color: var(--text-3); font-size: 12px; }
.related { display: flex; flex-direction: column; gap: 6px; }
.rel { display: flex; justify-content: space-between; padding: 9px 12px; border-radius: 8px; cursor: pointer; background: var(--panel-2); }
.rel:hover { background: var(--primary-weak); }
.rel-title { font-weight: 500; }
.rel-tag { color: var(--text-3); font-size: 12px; }
</style>