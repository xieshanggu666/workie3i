<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapTicketStore } from '@/stores/gap'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import { GAP, gapStatusLabel, gapActionLabel, canClaimGapTicket, canLinkGapTicket } from '@/utils/gap'
import { canEditContent } from '@/utils/permission'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const gapStore = useGapTicketStore()

const tab = ref('open') // open | claimed | in_review | resolved | all
const linkDocMap = ref({}) // ticketId -> 选中的关联文档 id
const linkNoteMap = ref({}) // ticketId -> 送审说明
const busyId = ref('')
const hint = ref('')

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

// 可关联的候选文档：按最近更新排序
const linkableDocs = computed(() =>
  [...kb.docs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

const list = computed(() => {
  if (tab.value === 'all') return gapStore.sorted
  return gapStore.ticketsByStatus(tab.value)
})

const counts = computed(() => ({
  open: gapStore.ticketsByStatus(GAP.OPEN).length,
  claimed: gapStore.ticketsByStatus(GAP.CLAIMED).length,
  in_review: gapStore.ticketsByStatus(GAP.IN_REVIEW).length,
  resolved: gapStore.ticketsByStatus(GAP.RESOLVED).length,
  all: gapStore.tickets.length
}))

function statusCls(status) {
  return { open: 'st-open', claimed: 'st-claimed', in_review: 'st-review', resolved: 'st-ok' }[status]
}

function toast(msg) {
  hint.value = msg
  setTimeout(() => { hint.value = '' }, 3000)
}

async function claim(t) {
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await gapStore.claimTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('认领失败：工单已被他人认领或状态已变化')
  } finally {
    busyId.value = ''
  }
}

async function linkAndSubmit(t) {
  const docId = linkDocMap.value[t.id]
  if (!docId) { alert('请先选择要关联的文档'); return }
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await gapStore.linkAndSubmit(t.id, docId, (linkNoteMap.value[t.id] || '').trim(), auth.user)
    if (res.status === 'ok') {
      toast('已关联文档并送审，等待管理员审批')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请等待审批完成后再送审。')
    } else if (res.status === 'doc-missing') {
      alert('关联的文档不存在或已被删除')
    } else {
      alert('送审失败：工单状态已变化')
    }
  } finally {
    busyId.value = ''
  }
}

// 新建文档补写：预填问题为标题；保存后回到本页并自动选中该文档
function goNewDoc(t) {
  router.push({ path: '/docs/new', query: { gap: t.id, title: t.question } })
}

onMounted(async () => {
  await gapStore.loadAll()
  // 从编辑器新建文档返回：自动定位工单并预选新建文档，便于直接送审
  if (route.query.ticket && route.query.linkDoc) {
    linkDocMap.value[route.query.ticket] = String(route.query.linkDoc)
    tab.value = 'claimed'
    toast('文档已创建，请确认关联并送审')
  }
})
</script>

<template>
  <div class="gap-page">
    <header class="head">
      <h2>🧩 知识缺口工单</h2>
      <p class="sub">成员把未解决的问答转为补写需求 → 编辑者认领并关联文档送审 → 审批发布后自动回填答案来源，驳回则退回处理。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'open' }" @click="tab = 'open'">待认领 <em>{{ counts.open }}</em></button>
        <button :class="{ on: tab === 'claimed' }" @click="tab = 'claimed'">处理中 <em>{{ counts.claimed }}</em></button>
        <button :class="{ on: tab === 'in_review' }" @click="tab = 'in_review'">送审中 <em>{{ counts.in_review }}</em></button>
        <button :class="{ on: tab === 'resolved' }" @click="tab = 'resolved'">已解决 <em>{{ counts.resolved }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部 <em>{{ counts.all }}</em></button>
      </div>
      <div v-if="hint" class="hint">✅ {{ hint }}</div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📭</div>
      {{ tab === 'open' ? '暂无待认领的补写需求' : tab === 'claimed' ? '暂无处理中的工单' : tab === 'in_review' ? '暂无送审中的工单' : tab === 'resolved' ? '暂无已解决的工单' : '暂无工单，可在智能问答页把未解决的问题转为补写需求' }}
    </div>

    <div v-else class="tk-list">
      <div v-for="t in list" :key="t.id" class="tk card">
        <div class="tk-top">
          <div class="tk-q">❓ {{ t.question }}</div>
          <div class="tk-side">
            <span class="st" :class="statusCls(t.status)">{{ gapStatusLabel(t.status) }}</span>
            <span class="tk-time">{{ formatDate(t.createdAt) }}</span>
          </div>
        </div>

        <div class="tk-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.createdBy) }">{{ userById[t.createdBy]?.avatar || '?' }}</span>
            {{ userById[t.createdBy]?.name || t.createdBy }} 提交
          </span>
          <span v-if="t.claimedBy" class="who">
            <span class="ava" :style="{ background: avatarColor(t.claimedBy) }">{{ userById[t.claimedBy]?.avatar || '?' }}</span>
            {{ userById[t.claimedBy]?.name || t.claimedBy }} 认领
          </span>
        </div>

        <div v-if="t.note" class="note">补充说明：“{{ t.note }}”</div>

        <!-- 已关联文档（送审中 / 已解决） -->
        <div v-if="t.docId && docById[t.docId]" class="linked">
          <span class="lk-label">关联文档：</span>
          <span class="lk-title" @click="router.push('/docs/' + t.docId)">{{ docById[t.docId].title }}</span>
          <DocPill :doc="docById[t.docId]" />
        </div>
        <div v-else-if="t.docId" class="linked missing">关联文档已删除</div>

        <!-- 已解决：自动回填的答案来源，全员可见 -->
        <div v-if="t.status === 'resolved'" class="answer-src">
          ✅ 答案来源：
          <template v-if="docById[t.answerDocId]">
            <a @click="router.push('/docs/' + t.answerDocId)">《{{ docById[t.answerDocId].title }}》</a>
          </template>
          <template v-else>文档已删除</template>
          <span class="rs-meta">由 {{ userById[t.resolvedBy]?.name || t.resolvedBy }} 审批发布于 {{ formatFull(t.resolvedAt) }}</span>
        </div>

        <!-- 待认领：编辑者/管理员可认领 -->
        <div v-if="canClaimGapTicket(auth.user?.role, t)" class="ops">
          <button class="btn sm primary" :disabled="busyId === t.id" @click="claim(t)">🙋 认领此工单</button>
        </div>

        <!-- 处理中：认领人/管理员关联文档送审 -->
        <div v-if="canLinkGapTicket(auth.user?.role, t, auth.user?.id)" class="link-box">
          <div class="lb-row">
            <select v-model="linkDocMap[t.id]">
              <option :value="undefined" disabled>选择要关联的文档…</option>
              <option v-for="d in linkableDocs" :key="d.id" :value="d.id">{{ d.title }}</option>
            </select>
            <button class="btn sm" @click="goNewDoc(t)">＋ 新建文档补写</button>
          </div>
          <input v-model="linkNoteMap[t.id]" placeholder="送审说明（可选，将写入评审留痕）" />
          <div class="lb-actions">
            <button class="btn sm primary" :disabled="busyId === t.id || !linkDocMap[t.id]" @click="linkAndSubmit(t)">📮 关联并送审</button>
          </div>
        </div>

        <!-- 送审中提示 -->
        <div v-if="t.status === 'in_review'" class="review-tip">
          ⏳ 已送审，等待管理员审批；审批发布后答案来源将自动回填，驳回则退回处理。
          <a @click="router.push('/reviews')">前往评审中心</a>
        </div>

        <details class="timeline">
          <summary>处理记录（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(tl, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ gapActionLabel(tl.action) }}</span>
            <span class="tl-who">{{ userById[tl.by]?.name || (tl.by === 'system' ? '系统' : tl.by) }}</span>
            <span v-if="tl.note" class="tl-note">“{{ tl.note }}”</span>
            <span class="tl-tm">{{ formatFull(tl.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!canEditContent(auth.user?.role)" class="foot-tip">当前身份为只读成员，可在智能问答页提交补写需求，认领与送审由编辑者/管理员完成。</p>
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
.hint { margin-top: 10px; color: var(--accent); font-size: 13px; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk-top { display: flex; justify-content: space-between; gap: 14px; }
.tk-q { font-weight: 700; font-size: 15px; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-ok { background: #dcfce7; color: #15803d; }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.note { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.linked { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.lk-label { color: var(--text-3); }
.lk-title { font-weight: 600; color: var(--primary); cursor: pointer; }
.lk-title:hover { text-decoration: underline; }
.linked.missing { color: var(--text-3); }
.answer-src { margin-top: 10px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.answer-src a { cursor: pointer; font-weight: 600; }
.rs-meta { margin-left: 8px; color: var(--text-3); font-size: 12px; }
.ops { margin-top: 12px; }
.link-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-row { display: flex; gap: 8px; }
.lb-row select { flex: 1; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 10px; font-size: 13px; outline: none; background: var(--panel); }
.lb-row select:focus { border-color: var(--primary); }
.link-box input { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 10px; font-size: 13px; outline: none; }
.link-box input:focus { border-color: var(--primary); }
.lb-actions { display: flex; gap: 8px; }
.review-tip { margin-top: 10px; font-size: 12px; color: #0369a1; background: #e0f2fe; border-radius: 8px; padding: 8px 12px; }
.review-tip a { cursor: pointer; margin-left: 4px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 150px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
