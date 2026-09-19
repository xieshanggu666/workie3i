// 权限工具：基于角色与文档可见性
import { isShareActive } from './share'
import { isDocInReview } from './review'

export const ROLE = { ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer' }

// 可新增/编辑/删除的（内容治理）
export function canEditContent(role) {
  return role === ROLE.ADMIN || role === ROLE.EDITOR
}

// 文档编辑者：角色可编辑 且（拥有者/协作成员/公开可编辑）
// pendingReview 非空表示该文档有流转中的评审单：评审中锁定编辑，仅管理员可继续直接改动
export function canEditDoc(role, doc, userId, pendingReview) {
  if (!doc) return false
  if (!canEditContent(role)) return false
  if (isDocInReview(doc, pendingReview) && role !== ROLE.ADMIN) return false
  if (doc.ownerId === userId) return true
  if (doc.editors && doc.editors.includes(userId)) return true
  return false
}

// 是否可查看某文档（可见性 + 拥有者 + 协作成员 + 有效共享链接）
export function canViewDoc(doc, userId, share) {
  if (!doc) return false
  if (doc.visibility === 'public') return true
  if (doc.visibility === 'team') {
    // team 指全员可见（演示简化：所有登录成员可见）
    return true
  }
  // private：仅拥有者与协作成员可见（或持有效共享链接——已撤销/已过期不授权）
  if (doc.ownerId === userId) return true
  if (doc.editors && doc.editors.includes(userId)) return true
  if (isShareActive(share)) return true
  return false
}

export function canDeleteDoc(role, doc, userId) {
  return canEditDoc(role, doc, userId)
}

export function roleLabel(role) {
  return { admin: '管理员', editor: '编辑者', viewer: '只读' }[role] || role
}