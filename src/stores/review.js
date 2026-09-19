import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions } from '@/utils/version'
import { REVIEW, PUBLISH, buildTimelineEntry } from '@/utils/review'
import { useKbStore } from './kb'
import { useGapTicketStore } from './gap'

// 知识文档评审流程 store：
// 发起（快照待审内容、文档置为评审中并锁定）→ 成员发表评审意见 →
// 管理员通过（回写正文/可见性、追加带审批标记的版本）或驳回（解除锁定，内容不变）→
// 全程在评审单 timeline 与评审意见中留痕
export const useReviewStore = defineStore('review', () => {
  const reviews = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    reviews.value = await db.reviews.toArray()
  }

  // 文档当前流转中的评审单（同一文档同时只允许一个）
  const pendingByDoc = computed(() => {
    const m = {}
    for (const r of reviews.value) {
      if (r.status === REVIEW.PENDING) m[r.docId] = r
    }
    return m
  })

  function pendingReviewOf(docId) {
    return pendingByDoc.value[docId] || null
  }

  function reviewsOfDoc(docId) {
    return reviews.value
      .filter((r) => r.docId === docId)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
  }

  // 评审单下的意见（按时间正序）
  function commentsOfReview(reviewId) {
    const kb = useKbStore()
    return kb.comments
      .filter((c) => c.reviewId === reviewId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  // 发起评审。
  // patch：本次提交待审批的文档字段（title/body/categoryId/tagIds/visibility）
  // 文档在审批期间保持旧内容可见，但置为「评审中」并锁定编辑；审批通过后才回写
  async function submitReview(docId, patch, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const review = {
        id: uid('rev'),
        docId,
        status: REVIEW.PENDING,
        submittedBy: userId,
        submittedAt: now,
        // 待审批的目标字段快照；审批通过时据此回写，保证「先审后发」
        snapshot: {
          title: patch.title,
          body: patch.body,
          categoryId: patch.categoryId,
          tagIds: patch.tagIds || [],
          visibility: patch.visibility
        },
        baseVersion: ensureVersions(doc, now).length,
        decidedBy: null,
        decidedAt: null,
        decisionNote: '',
        timeline: [buildTimelineEntry('submit', userId, note, now)]
      }
      await db.reviews.add(review)

      // 文档进入评审中：正文锁定，旧内容继续可见，待审批内容不提前泄露
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      if (note && note.trim()) {
        const cmt = {
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: now
        }
        await db.comments.add(cmt)
        kb.comments.push(cmt)
      }
      result = { status: 'ok', review }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 成员发表评审意见：同时写入 comments（联动评论区）与评审单 timeline（留痕）
  async function addReviewComment(reviewId, content, mentionIds, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let created = null

    await db.transaction('rw', db.reviews, db.comments, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review || review.status !== REVIEW.PENDING) return
      const cmt = {
        id: uid('cmt'), docId: review.docId, reviewId, authorId: userId,
        content, mentionIds: mentionIds || [], createdAt: now
      }
      await db.comments.add(cmt)
      await db.reviews.update(reviewId, {
        timeline: [...(review.timeline || []), buildTimelineEntry('comment', userId, content, now)]
      })
      created = cmt
    })

    if (created) {
      kb.comments.push(created)
      await reload()
    }
    return created
  }

  // 管理员审批：approve 通过 / reject 驳回。
  // 通过：把待审批快照回写到文档（含可见性），追加「审批通过」版本，解除评审中状态；
  // 驳回：文档内容与可见性保持发起前不变，仅解除锁定并留痕。
  async function decideReview(reviewId, decision, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (review.status !== REVIEW.PENDING) { result = { status: 'closed', review }; return }

      const doc = await db.docs.get(review.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }

      const status = decision === 'approve' ? REVIEW.APPROVED : REVIEW.REJECTED
      const timeline = [
        ...(review.timeline || []),
        buildTimelineEntry(status === REVIEW.APPROVED ? 'approve' : 'reject', userId, note, now)
      ]
      const decided = {
        ...review,
        status,
        decidedBy: userId,
        decidedAt: now,
        decisionNote: note || '',
        timeline
      }

      if (status === REVIEW.APPROVED) {
        // 回写审批通过的内容与可见性，并追加带审批标记的新版本（留痕到版本历史）
        const versions = ensureVersions(doc, now)
        const nextVersion = versions.length + 1
        const updated = {
          ...doc,
          ...review.snapshot,
          visibility: review.snapshot.visibility,
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          updatedAt: now,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '', version: nextVersion },
          versions: [...versions, {
            version: nextVersion,
            savedAt: now,
            savedBy: review.submittedBy,
            note: '评审通过后发布' + (note ? '：' + note : ''),
            reviewStatus: REVIEW.APPROVED,
            reviewId,
            decidedBy: userId
          }]
        }
        await db.docs.put(updated)
      } else {
        // 驳回不改内容，仅解除评审中锁定；驳回结论挂到文档上供详情页提示
        await db.docs.update(review.docId, {
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '' }
        })
      }

      await db.reviews.put(decided)
      result = { status: 'ok', review: decided, approved: status === REVIEW.APPROVED }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    // 审批结论回传缺口工单：通过则回填答案来源，驳回则退回处理（延迟调用避免循环依赖）
    if (result.status === 'ok') await useGapTicketStore().syncFromReview(result.review)
    return result
  }

  // 发起人撤回评审：文档解除锁定，待审内容不生效
  async function withdrawReview(reviewId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (review.status !== REVIEW.PENDING || review.submittedBy !== userId) { result = { status: 'denied' }; return }
      const withdrawn = {
        ...review,
        status: REVIEW.WITHDRAWN,
        timeline: [...(review.timeline || []), buildTimelineEntry('withdraw', userId, '', now)]
      }
      await db.reviews.put(withdrawn)
      await db.docs.update(review.docId, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })
      result = { status: 'ok', review: withdrawn }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    // 撤回送审同样回传缺口工单：工单退回处理中
    if (result.status === 'ok') await useGapTicketStore().syncFromReview(result.review)
    return result
  }

  // 删除文档时连带清理评审单
  async function deleteReviewsOfDoc(docId) {
    await db.reviews.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  // 待我审批（管理员视角）/ 我发起的（编辑者视角）
  const pendingCount = computed(() => reviews.value.filter((r) => r.status === REVIEW.PENDING).length)

  return {
    reviews, loaded, loadAll, reload,
    pendingByDoc, pendingReviewOf, reviewsOfDoc, commentsOfReview,
    submitReview, addReviewComment, decideReview, withdrawReview,
    deleteReviewsOfDoc, pendingCount
  }
})
