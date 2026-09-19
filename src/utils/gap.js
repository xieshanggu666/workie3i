// 知识缺口工单：状态常量、权限判定、留痕工具（均为纯函数，便于复用与测试）
import { ROLE, canEditContent } from './permission'

// 工单状态
export const GAP = {
  OPEN: 'open', // 待认领：成员已提交补写需求，等待编辑者认领
  CLAIMED: 'claimed', // 处理中：编辑者已认领，正在补写/关联文档
  IN_REVIEW: 'in_review', // 送审中：已关联文档并发起评审，等待管理员审批
  RESOLVED: 'resolved' // 已解决：审批发布后答案来源已自动回填
}

export function gapStatusLabel(status) {
  return { open: '待认领', claimed: '处理中', in_review: '送审中', resolved: '已解决' }[status] || status
}

// 工单是否仍在流转（未解决）
export function isGapOpen(ticket) {
  return !!ticket && ticket.status !== GAP.RESOLVED
}

// 提交补写需求：任何登录成员（含只读成员）均可；访客不可
export function canCreateGapTicket(user) {
  return !!user?.id && user.id !== 'u-guest'
}

// 认领工单：仅编辑者/管理员，且工单处于待认领
export function canClaimGapTicket(role, ticket) {
  return ticket?.status === GAP.OPEN && canEditContent(role)
}

// 关联文档并送审：认领人本人或管理员，且工单处于处理中
export function canLinkGapTicket(role, ticket, userId) {
  if (ticket?.status !== GAP.CLAIMED || !canEditContent(role)) return false
  return ticket.claimedBy === userId || role === ROLE.ADMIN
}

// 工单处理记录的动作文案（timeline 全程保留）
export function gapActionLabel(action) {
  return {
    create: '提交补写需求',
    claim: '认领工单',
    submit: '关联文档并送审',
    approve: '审批通过 · 回填答案来源',
    reject: '审批驳回 · 退回处理',
    withdraw: '撤回送审 · 退回处理',
    'doc-deleted': '关联文档已删除 · 退回待认领'
  }[action] || action
}
