import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { REVIEW, buildTimelineEntry } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { useKbStore } from './kb'
import { useReviewStore } from './review'

// 知识缺口工单 store：
// 成员把未解决的问答转为补写需求（open）→ 编辑者认领（claimed）→
// 关联文档并发起评审（in_review）→ 管理员审批发布后自动回填答案来源（resolved），
// 驳回/撤回则退回处理中（claimed）；全程在工单 timeline 留痕
export const useGapTicketStore = defineStore('gapTicket', () => {
  const tickets = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    tickets.value = await db.gapTickets.toArray()
  }

  const sorted = computed(() =>
    [...tickets.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  function ticketsByStatus(status) {
    return sorted.value.filter((t) => t.status === status)
  }

  // 同一问题的在途工单（问答页据此避免重复提交）
  function findActiveByQuestion(question) {
    const q = String(question || '').trim()
    if (!q) return null
    return tickets.value.find((t) => t.question === q && t.status !== GAP.RESOLVED) || null
  }

  // 成员提交补写需求：来自问答页未解决的问题
  async function createTicket(question, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    const ticket = {
      id: uid('gap'),
      question: String(question || '').trim(),
      note: note || '',
      status: GAP.OPEN,
      createdBy: userId,
      createdAt: now,
      claimedBy: null,
      claimedAt: null,
      // 关联的文档与评审单（送审时写入）
      docId: null,
      reviewId: null,
      // 审批发布后自动回填的答案来源
      answerDocId: null,
      resolvedAt: null,
      resolvedBy: null,
      timeline: [buildTimelineEntry('create', userId, note, now)]
    }
    await db.gapTickets.add(ticket)
    await reload()
    return { status: 'ok', ticket }
  }

  // 编辑者/管理员认领：工单进入处理中
  async function claimTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }
    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== GAP.OPEN) { result = { status: 'claimed', ticket: t }; return }
      await db.gapTickets.update(id, {
        status: GAP.CLAIMED,
        claimedBy: userId,
        claimedAt: now,
        timeline: [...(t.timeline || []), buildTimelineEntry('claim', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 认领人关联文档并送审：以文档当前内容为待审快照发起评审，工单转入送审中。
  // 审批结果由 review store 通过 syncFromReview 回传，本函数不等待审批
  async function linkAndSubmit(id, docId, note, currentUser) {
    const kb = useKbStore()
    const reviewStore = useReviewStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    const t = tickets.value.find((x) => x.id === id)
    if (!t) return { status: 'missing' }
    if (t.status !== GAP.CLAIMED) return { status: 'bad-state' }

    const doc = await kb.getDocFresh(docId)
    if (!doc) return { status: 'doc-missing' }

    const submitNote = note || '关联缺口工单：' + t.question
    const res = await reviewStore.submitReview(docId, {
      title: doc.title,
      body: doc.body,
      categoryId: doc.categoryId,
      tagIds: doc.tagIds || [],
      visibility: doc.visibility
    }, submitNote, currentUser)
    if (res.status !== 'ok') return res

    await db.gapTickets.update(id, {
      status: GAP.IN_REVIEW,
      docId,
      reviewId: res.review.id,
      timeline: [...(t.timeline || []), buildTimelineEntry('submit', userId, '关联文档《' + doc.title + '》并送审' + (note ? '：' + note : ''), now)]
    })
    await reload()
    return { status: 'ok', review: res.review }
  }

  // 评审结论回传（由 review store 在审批/撤回后调用）：
  // 通过 → 工单解决并自动回填答案来源；驳回/撤回 → 退回处理中，等待重新送审
  async function syncFromReview(review) {
    if (!review) return
    await loadAll()
    const t = tickets.value.find((x) => x.reviewId === review.id)
    if (!t) return
    const now = new Date().toISOString()

    if (review.status === REVIEW.APPROVED) {
      await db.gapTickets.update(t.id, {
        status: GAP.RESOLVED,
        answerDocId: review.docId,
        resolvedAt: review.decidedAt || now,
        resolvedBy: review.decidedBy,
        timeline: [...(t.timeline || []), buildTimelineEntry('approve', review.decidedBy, review.decisionNote || '', review.decidedAt || now)]
      })
    } else if (review.status === REVIEW.REJECTED) {
      await db.gapTickets.update(t.id, {
        status: GAP.CLAIMED,
        timeline: [...(t.timeline || []), buildTimelineEntry('reject', review.decidedBy, review.decisionNote || '', review.decidedAt || now)]
      })
    } else if (review.status === REVIEW.WITHDRAWN) {
      await db.gapTickets.update(t.id, {
        status: GAP.CLAIMED,
        reviewId: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('withdraw', review.submittedBy, '', now)]
      })
    } else {
      return
    }
    await reload()
  }

  // 待认领数量（侧边栏角标，面向编辑者/管理员）
  const openCount = computed(() => tickets.value.filter((t) => t.status === GAP.OPEN).length)

  return {
    tickets, loaded, loadAll, reload, sorted, ticketsByStatus,
    findActiveByQuestion, createTicket, claimTicket, linkAndSubmit, syncFromReview,
    openCount
  }
})
