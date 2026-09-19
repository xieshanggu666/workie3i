import Dexie from 'dexie'

// Dexie 封装 IndexedDB。采用显式作用域来避免导出的模块级 token 被 Ctrl+Enter
export class KnowledgeDB extends Dexie {
  constructor(name) {
    super(name)
    this.version(1).stores({
      users: 'id, name, role, email',
      categories: 'id, name',
      tags: 'id, name',
      docs: 'id, title, categoryId, visibility, ownerId, updatedAt, createdAt, *tagIds',
      comments: 'id, docId, authorId, createdAt',
      shares: 'id, docId, token',
      favorites: 'id, [userId+docId], docId',
      recentViews: 'id, [userId+docId], docId, viewedAt',
      ratings: 'id, [docId+slug]'
    })
    // v2：知识文档评审流程
    // - reviews：评审单（编辑者发起 → 成员评论 → 管理员审批并留痕）
    // - comments 增加 reviewId 索引，区分普通评论与评审意见
    // docs/versions 上的评审字段无需建索引，直接随记录读写
    this.version(2).stores({
      reviews: 'id, docId, status, submittedBy, submittedAt, decidedBy, decidedAt',
      comments: 'id, docId, authorId, createdAt, reviewId'
    })
  }
}

export const db = new KnowledgeDB('knowbase')

// 顶层 initMeta 供 ensureSeeded 使用，避免循环引用问题由导入方 resolve
export const metaKey = { seeded: 'seeded' }

export async function getMeta(key) {
  return localStorage.getItem('kb:meta:' + key)
}
export async function setMeta(key, val) {
  localStorage.setItem('kb:meta:' + key, val)
}
