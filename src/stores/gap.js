import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { GAP, normalizeQuestion } from '@/utils/gap'

// 知识缺口工单 store：
// 成员把未解决的问答转为补写需求（open）→ 编辑者认领（claimed）→ 关联文档送审（in_review，
// 评审单由调用方先创建成功）→ 管理员审批通过自动回填答案来源（resolved）/ 驳回退回处理（claimed）。
// 审批联动在 review store 的 decideReview/withdrawReview 中同事务完成，这里只负责工单自身的读写。
export const useGapStore = defineStore('gap', () => {
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

  // 待认领数量（侧边栏角标）
  const openCount = computed(() => tickets.value.filter((t) => t.status === GAP.OPEN).length)

  // 同一问题是否已有未解决工单（问答页提示与创建去重）
  function activeTicketForQuestion(question) {
    const q = normalizeQuestion(question)
    if (!q) return null
    return tickets.value.find((t) => t.status !== GAP.RESOLVED && normalizeQuestion(t.question) === q) || null
  }

  // 已解决工单中匹配关键词的答案来源（问答页自动回填展示）
  function resolvedTicketsMatching(keywords = []) {
    const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
    if (!kws.length) return []
    return tickets.value
      .filter((t) => t.status === GAP.RESOLVED && t.docId)
      .map((t) => ({
        ticket: t,
        score: kws.reduce((n, k) => n + (String(t.question).toLowerCase().includes(k) ? 1 : 0), 0)
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.ticket.resolvedAt) - new Date(a.ticket.resolvedAt))
      .map((x) => x.ticket)
  }

  // 成员提交补写需求。同问题存在未解决工单时直接返回已有工单，避免重复
  async function createTicket({ question, detail }, currentUser) {
    await loadAll()
    const userId = currentUser?.id || 'u-guest'
    const dup = activeTicketForQuestion(question)
    if (dup) return { status: 'duplicate', ticket: dup }
    const now = new Date().toISOString()
    const ticket = {
      id: uid('gap'),
      question: String(question || '').trim(),
      detail: String(detail || '').trim(),
      status: GAP.OPEN,
      createdBy: userId,
      createdAt: now,
      claimedBy: null,
      claimedAt: null,
      docId: null,
      reviewId: null,
      resolvedAt: null,
      timeline: [buildTimelineEntry('create', userId, '', now)]
    }
    await db.gapTickets.add(ticket)
    await reload()
    return { status: 'ok', ticket }
  }

  // 编辑者认领：open → claimed
  async function claimTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }
    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== GAP.OPEN) { result = { status: 'changed', ticket: t }; return }
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

  // 取消认领：claimed → open，清空认领人
  async function releaseTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }
    await db.transaction('rw', db.gapTickets, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== GAP.CLAIMED) { result = { status: 'changed', ticket: t }; return }
      await db.gapTickets.update(id, {
        status: GAP.OPEN,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('release', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 关联文档送审成功后回写：claimed → in_review。
  // 评审单由调用方（工单中心）先通过 review store 创建成功，这里只记录关联关系
  async function markInReview(id, docId, reviewId, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }
    await db.transaction('rw', db.gapTickets, db.docs, async () => {
      const t = await db.gapTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== GAP.CLAIMED) { result = { status: 'changed', ticket: t }; return }
      const doc = await db.docs.get(docId)
      await db.gapTickets.update(id, {
        status: GAP.IN_REVIEW,
        docId,
        reviewId,
        timeline: [...(t.timeline || []), buildTimelineEntry('submit', userId, '关联文档《' + (doc?.title || docId) + '》送审', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  return {
    tickets, loaded, loadAll, reload, openCount,
    activeTicketForQuestion, resolvedTicketsMatching,
    createTicket, claimTicket, releaseTicket, markInReview
  }
})
