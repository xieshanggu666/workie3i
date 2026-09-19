<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  GAP, gapStatusLabel, gapStatusCls, gapTimelineLabel,
  canClaimTicket, canReleaseTicket, canSubmitGapReview
} from '@/utils/gap'
import { canEditContent } from '@/utils/permission'
import { reviewStatusLabel } from '@/utils/review'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const gapStore = useGapStore()

const tab = ref(GAP.OPEN) // open | claimed | in_review | resolved | all
const pickDoc = ref({}) // ticketId -> 待送审的关联文档 id
const busyId = ref('')
const toast = ref('')

const TABS = [
  { key: GAP.OPEN, label: '待认领' },
  { key: GAP.CLAIMED, label: '处理中' },
  { key: GAP.IN_REVIEW, label: '送审中' },
  { key: GAP.RESOLVED, label: '已解决' },
  { key: 'all', label: '全部' }
]

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const canEdit = computed(() => canEditContent(auth.user?.role))

const sorted = computed(() =>
  [...gapStore.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)
const list = computed(() =>
  tab.value === 'all' ? sorted.value : sorted.value.filter((t) => t.status === tab.value)
)
const counts = computed(() => {
  const c = { all: gapStore.tickets.length }
  for (const s of [GAP.OPEN, GAP.CLAIMED, GAP.IN_REVIEW, GAP.RESOLVED]) {
    c[s] = gapStore.tickets.filter((t) => t.status === s).length
  }
  return c
})
const emptyText = computed(() => ({
  [GAP.OPEN]: '暂无待认领的补写需求',
  [GAP.CLAIMED]: '暂无处理中的工单',
  [GAP.IN_REVIEW]: '暂无送审中的工单',
  [GAP.RESOLVED]: '暂无已解决的工单',
  all: '暂无缺口工单，去智能问答提交未解决的问题吧'
}[tab.value]))

// 可关联的文档：当前没有流转中评审单的文档（送审会锁定文档，需错开）
const linkableDocs = computed(() =>
  [...kb.docs]
    .filter((d) => !reviewStore.pendingReviewOf(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

// 送审中工单对应的评审单状态（正常应为待审批，兜底展示历史结论）
function reviewOf(t) {
  return t.reviewId ? reviewStore.reviews.find((r) => r.id === t.reviewId) : null
}

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 3000)
}

async function claim(t) {
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await gapStore.claimTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('认领失败：工单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

async function release(t) {
  if (busyId.value) return
  if (!confirm('确定取消认领？工单将退回「待认领」。')) return
  busyId.value = t.id
  try {
    await gapStore.releaseTicket(t.id, auth.user)
  } finally {
    busyId.value = ''
  }
}

// 关联文档送审：先通过评审流程创建评审单（文档进入评审中），成功后回写工单为送审中
async function submitGapReview(t) {
  const docId = pickDoc.value[t.id]
  if (!docId || busyId.value) return
  busyId.value = t.id
  try {
    const d = await kb.getDocFresh(docId)
    if (!d) { alert('文档不存在或已被删除'); return }
    const res = await reviewStore.submitReview(docId, {
      title: d.title, body: d.body, categoryId: d.categoryId,
      tagIds: d.tagIds || [], visibility: d.visibility
    }, '补写缺口工单：' + t.question, auth.user)
    if (res.status === 'ok') {
      await gapStore.markInReview(t.id, docId, res.review.id, auth.user)
      showToast('已关联文档并送审，管理员审批通过后将自动回填答案来源')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请换一篇文档或等待审批完成。')
    } else {
      alert('送审失败：文档不存在或状态已变化')
    }
  } finally {
    busyId.value = ''
  }
}

// 新建文档补写：携带工单 id 与问题作为标题，发布文档后回到本页继续送审
function goNewDoc(t) {
  router.push({ path: '/docs/new', query: { gap: t.id, title: t.question } })
}

onMounted(async () => {
  await Promise.all([gapStore.loadAll(), reviewStore.loadAll()])
  // 从编辑器「新建文档补写」返回：定位到该工单并预选刚创建的文档
  if (route.query.pick) {
    tab.value = GAP.CLAIMED
    if (route.query.doc) pickDoc.value = { ...pickDoc.value, [route.query.pick]: route.query.doc }
    showToast('文档已创建，确认关联文档后点击「关联并送审」')
  }
})
</script>

<template>
  <div class="gap-page">
    <header class="head">
      <h2>📮 知识缺口工单</h2>
      <p class="sub">成员把未解决的问答转为补写需求 → 编辑者认领并关联文档送审 → 审批通过后自动回填答案来源，驳回则退回处理，全程留痕。</p>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }} <em>{{ counts[t.key] }}</em>
        </button>
      </div>
    </header>

    <div v-if="toast" class="card toast-line">✅ {{ toast }}</div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📭</div>
      {{ emptyText }}
    </div>

    <div v-else class="tk-list">
      <div v-for="t in list" :key="t.id" class="tk card" :class="{ picked: route.query.pick === t.id }">
        <div class="tk-top">
          <div class="tk-q">❓ {{ t.question }}</div>
          <div class="tk-side">
            <span class="st" :class="gapStatusCls(t.status)">{{ gapStatusLabel(t.status) }}</span>
            <span class="tk-time">{{ formatDate(t.createdAt) }}</span>
          </div>
        </div>
        <div v-if="t.detail" class="tk-detail">{{ t.detail }}</div>

        <div class="tk-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.createdBy) }">{{ userById[t.createdBy]?.avatar || '?' }}</span>
            {{ userById[t.createdBy]?.name || t.createdBy }} 提交
          </span>
          <span v-if="t.claimedBy" class="who">认领人：<b>{{ userById[t.claimedBy]?.name || t.claimedBy }}</b></span>
          <span v-else class="who none">暂未认领</span>
          <span v-if="t.resolvedAt" class="resolved-at">已于 {{ formatFull(t.resolvedAt) }} 解决</span>
        </div>

        <!-- 已解决：审批通过后自动回填的答案来源 -->
        <div v-if="t.status === GAP.RESOLVED" class="answer-src" @click="docById[t.docId] && router.push('/docs/' + t.docId)">
          💡 答案来源：《{{ docById[t.docId]?.title || '文档已删除' }}》
          <span v-if="docById[t.docId]" class="go">查看文档 →</span>
        </div>

        <!-- 送审中/处理中已关联的文档 -->
        <div v-else-if="t.docId" class="linked-doc">
          <span class="lk-label">关联文档：</span>
          <template v-if="docById[t.docId]">
            <span class="lk-title" @click="router.push('/docs/' + t.docId)">《{{ docById[t.docId].title }}》</span>
            <DocPill :doc="docById[t.docId]" />
          </template>
          <span v-else class="lk-missing">文档已删除</span>
        </div>

        <!-- 待认领：编辑者/管理员可认领 -->
        <div v-if="canClaimTicket(auth.user?.role, t)" class="acts">
          <button class="btn sm primary" :disabled="busyId === t.id" @click="claim(t)">🙋 认领补写</button>
        </div>

        <!-- 处理中（认领人/管理员）：关联文档送审 -->
        <div v-else-if="canSubmitGapReview(auth.user?.role, t, auth.user?.id)" class="claim-box">
          <div class="lk-row">
            <select v-model="pickDoc[t.id]">
              <option value="" disabled>选择要关联的文档…</option>
              <option v-for="d in linkableDocs" :key="d.id" :value="d.id">{{ d.title }}</option>
            </select>
            <button class="btn sm primary" :disabled="!pickDoc[t.id] || busyId === t.id" @click="submitGapReview(t)">📤 关联并送审</button>
            <button class="btn sm" @click="goNewDoc(t)">＋ 新建文档补写</button>
            <button v-if="canReleaseTicket(auth.user?.role, t, auth.user?.id)" class="btn sm ghost" :disabled="busyId === t.id" @click="release(t)">取消认领</button>
          </div>
          <div class="lk-hint">送审后工单进入「送审中」，文档同步锁定待审；审批通过即自动回填答案来源，驳回将退回处理。</div>
        </div>

        <!-- 其他成员视角的处理中 -->
        <div v-else-if="t.status === GAP.CLAIMED" class="state-tip">🖊 认领人补写中，待关联文档送审…</div>

        <!-- 送审中 -->
        <div v-else-if="t.status === GAP.IN_REVIEW" class="state-tip">
          ⏳ 已送审，等待管理员审批<template v-if="reviewOf(t)">（评审单{{ reviewStatusLabel(reviewOf(t).status) }}）</template>。
          <a v-if="t.docId" @click="router.push('/docs/' + t.docId)">查看评审进度 →</a>
        </div>

        <details class="timeline">
          <summary>处理记录（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(e, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ gapTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!canEdit" class="foot-tip">当前身份为只读成员：可在智能问答页提交补写需求，认领与送审由编辑者/管理员完成。</p>
  </div>
</template>

<style scoped>
.gap-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.toast-line { margin-top: 14px; padding: 10px 18px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk.picked { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-weak); }
.tk-top { display: flex; justify-content: space-between; gap: 14px; }
.tk-q { font-weight: 700; font-size: 15px; min-width: 0; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-detail { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.who.none { color: var(--text-3); }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.resolved-at { font-size: 12px; color: var(--text-3); }
.answer-src { margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.answer-src .go { margin-left: auto; font-size: 12px; }
.linked-doc { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.lk-label { color: var(--text-3); }
.lk-title { color: var(--primary); font-weight: 600; cursor: pointer; }
.lk-title:hover { text-decoration: underline; }
.lk-missing { color: var(--text-3); }
.acts { margin-top: 12px; }
.claim-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.lk-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lk-row select { flex: 1; min-width: 220px; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; background: var(--panel); outline: none; }
.lk-row select:focus { border-color: var(--primary); }
.lk-hint { margin-top: 8px; font-size: 12px; color: var(--text-3); }
.state-tip { margin-top: 12px; font-size: 13px; color: var(--text-2); }
.state-tip a { cursor: pointer; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 150px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
