// 知识缺口工单：状态常量、权限判定与文案（均为纯函数，便于复用与测试）
// 工单流转：open 待认领 → claimed 处理中 → in_review 送审中 → resolved 已解决
// 评审驳回/撤回时退回 claimed；关联文档被删除时也退回 claimed 并清空关联
import { ROLE, canEditContent } from './permission'

// 工单状态
export const GAP = {
  OPEN: 'open', // 待认领：成员已提交补写需求
  CLAIMED: 'claimed', // 处理中：编辑者已认领，补写/关联文档中
  IN_REVIEW: 'in_review', // 送审中：已关联文档并发起评审，等待管理员审批
  RESOLVED: 'resolved' // 已解决：审批通过，答案来源已自动回填
}

export function gapStatusLabel(status) {
  return { open: '待认领', claimed: '处理中', in_review: '送审中', resolved: '已解决' }[status] || status
}

export function gapStatusCls(status) {
  return { open: 'st-open', claimed: 'st-claimed', in_review: 'st-review', resolved: 'st-resolved' }[status] || ''
}

// 问题归一化：去空白转小写后比较，用于同问题工单去重
export function normalizeQuestion(q) {
  return String(q || '').trim().replace(/\s+/g, '').toLowerCase()
}

// 认领工单：编辑者/管理员，且工单处于待认领
export function canClaimTicket(role, ticket) {
  return !!ticket && ticket.status === GAP.OPEN && canEditContent(role)
}

// 是否为工单当前处理人（认领人本人或管理员）
export function isTicketOwner(ticket, userId, role) {
  return !!ticket && (ticket.claimedBy === userId || role === ROLE.ADMIN)
}

// 取消认领：处理中且为处理人
export function canReleaseTicket(role, ticket, userId) {
  return !!ticket && ticket.status === GAP.CLAIMED && isTicketOwner(ticket, userId, role)
}

// 关联文档送审：与取消认领同一前置条件（处理中且为处理人）
export function canSubmitGapReview(role, ticket, userId) {
  return canReleaseTicket(role, ticket, userId)
}

// 工单处理记录的动作文案（timeline 全程保留）
export function gapTimelineLabel(action) {
  return {
    create: '创建工单',
    claim: '认领工单',
    release: '取消认领',
    submit: '关联文档送审',
    resolve: '审批通过 · 回填答案来源',
    return: '退回处理',
    reset: '关联文档已删除'
  }[action] || action
}
