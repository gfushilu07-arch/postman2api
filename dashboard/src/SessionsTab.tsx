import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteSessionBindings,
  fetchSessionBindings,
  recoverSessionConversation,
  releaseSessionBindings,
  type SessionBinding,
  type SessionBindingSummary,
} from "./lib/api";

type ToastType = "success" | "error" | "info";
type SessionFilter = "all" | "in_flight" | "active" | "idle" | "abnormal" | "unbound";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const EMPTY_SUMMARY: SessionBindingSummary = {
  total: 0,
  active30m: 0,
  boundAccounts: 0,
  abnormal: 0,
  recoverable: 0,
};

function sessionState(item: SessionBinding): Exclude<SessionFilter, "all"> {
  if (item.isInFlight) return "in_flight";
  if (item.abnormal) return "abnormal";
  if (item.accountId === null) return "unbound";
  return Date.now() - new Date(item.updatedAt).getTime() <= ACTIVE_WINDOW_MS ? "active" : "idle";
}

function sessionStateLabel(item: SessionBinding): string {
  return {
    in_flight: "使用中",
    active: "活跃",
    idle: "空闲",
    abnormal: "账号异常",
    unbound: "未绑定",
  }[sessionState(item)];
}

function maskSessionId(sessionId: string): string {
  const separator = sessionId.indexOf(":");
  const scope = separator >= 0 ? sessionId.slice(0, separator + 1) : "";
  const value = separator >= 0 ? sessionId.slice(separator + 1) : sessionId;
  if (value.length <= 8) return `${scope}${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${scope}${value.slice(0, 4)}***${value.slice(-4)}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function formatRelative(value: string): string {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function accountLabel(item: SessionBinding): string {
  if (!item.accountEmail) return item.accountId === null ? "未绑定" : "账号已删除";
  return item.accountEmail;
}

function accountStatus(item: SessionBinding): { label: string; badge: string } {
  if (item.accountId === null) return { label: "未绑定", badge: "disabled" };
  if (!item.accountEmail) return { label: "已删除", badge: "error" };
  if (!item.accountEnabled) return { label: "禁用", badge: "disabled" };
  if (item.accountStatus === "exhausted") return { label: "耗尽", badge: "exhausted" };
  if (item.accountStatus !== "active") return { label: "异常", badge: "error" };
  return { label: "正常", badge: "active" };
}

export default function SessionsTab({
  showToast,
  onViewAccount,
}: {
  showToast: (message: string, type?: ToastType) => void;
  onViewAccount: (accountId: number) => void;
}) {
  const [sessions, setSessions] = useState<SessionBinding[]>([]);
  const [summary, setSummary] = useState<SessionBindingSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<SessionBinding | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveringSessionId, setRecoveringSessionId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ mode: "release" | "delete"; ids: string[] } | null>(null);

  const load = useCallback(async (silent = false) => {
    try {
      const response = await fetchSessionBindings();
      setSessions(response.data);
      setSummary(response.summary);
      setSelected((current) => {
        const existing = new Set(response.data.map((item) => item.sessionId));
        const next = new Set([...current].filter((id) => existing.has(id)));
        return next.size === current.size ? current : next;
      });
      setDetail((current) => current
        ? response.data.find((item) => item.sessionId === current.sessionId) || null
        : null);
    } catch (error: any) {
      if (!silent) showToast(`加载会话失败：${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleLoad = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(true), 400);
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "session_updated" || message.type === "account_status") scheduleLoad();
    };
    const poll = setInterval(() => {
      if (!document.hidden && ws.readyState !== WebSocket.OPEN) void load(true);
    }, 30000);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      ws.close();
      clearInterval(poll);
    };
  }, [load]);

  const accounts = useMemo(() => {
    const unique = new Map<number, string>();
    for (const item of sessions) {
      if (item.accountId !== null) unique.set(item.accountId, item.accountEmail || `账号 #${item.accountId}`);
    }
    return [...unique.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [sessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((item) => {
      if (filter !== "all" && sessionState(item) !== filter) return false;
      if (accountFilter !== "all" && String(item.accountId) !== accountFilter) return false;
      if (!needle) return true;
      return item.sessionId.toLowerCase().includes(needle)
        || (item.accountEmail || "").toLowerCase().includes(needle);
    });
  }, [sessions, query, filter, accountFilter]);

  const counts = useMemo(() => {
    const result: Record<SessionFilter, number> = {
      all: sessions.length,
      in_flight: 0,
      active: 0,
      idle: 0,
      abnormal: 0,
      unbound: 0,
    };
    for (const item of sessions) result[sessionState(item)]++;
    return result;
  }, [sessions]);

  const selectable = filtered.filter((item) => !item.isInFlight);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.sessionId));

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) selectable.forEach((item) => next.delete(item.sessionId));
      else selectable.forEach((item) => next.add(item.sessionId));
      return next;
    });
  };

  const toggleOne = (sessionId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const copyId = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
      showToast("会话 ID 已复制", "success");
    } catch {
      showToast("复制失败，请手动复制", "error");
    }
  };

  const recoverConversation = async (item: SessionBinding) => {
    if (item.isInFlight || item.hasConversation || recoveringSessionId) return;
    setRecoveringSessionId(item.sessionId);
    try {
      const result = await recoverSessionConversation(item.sessionId);
      showToast(
        result.alreadyBound
          ? "该会话已经绑定 Postman 上游会话"
          : `已从 Postman 云端历史恢复上游会话${result.scanned ? `（核对 ${result.scanned} 个候选）` : ""}`,
        "success",
      );
      await load(true);
    } catch (error: any) {
      showToast(error.message, "error");
    } finally {
      setRecoveringSessionId(null);
    }
  };

  const execute = async () => {
    if (!confirm || confirm.ids.length === 0) return;
    setBusy(true);
    try {
      if (confirm.mode === "release") await releaseSessionBindings(confirm.ids);
      else await deleteSessionBindings(confirm.ids);
      showToast(
        confirm.mode === "release"
          ? `已解除 ${confirm.ids.length} 个会话的账号绑定`
          : `已清除 ${confirm.ids.length} 个会话`,
        "success",
      );
      setSelected(new Set());
      setDetail(null);
      setConfirm(null);
      await load(true);
    } catch (error: any) {
      showToast(`${confirm.mode === "release" ? "解除绑定" : "清除会话"}失败：${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const filterLabels: Array<[SessionFilter, string]> = [
    ["all", "全部"],
    ["in_flight", "使用中"],
    ["active", "活跃"],
    ["idle", "空闲"],
    ["abnormal", "账号异常"],
    ["unbound", "未绑定"],
  ];

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">会话绑定</div>
          <div className="page-sub">查看会话与账号的粘性绑定，处理异常绑定和本地上下文</div>
        </div>
        <div className="page-actions">
          <span className="live-dot">WebSocket 实时刷新</span>
          <button className="page-action-btn" onClick={() => void load()} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.6"/><path d="M20 20v-5h-5"/></svg>
            刷新
          </button>
        </div>
      </div>

      <div className="section-head"><div className="section-title">会话概览</div></div>
      <div className="stat-grid session-stat-grid">
        <div className="stat-cell"><div className="stat-top"><div className="stat-label">会话总数</div></div><div className="stat-num">{summary.total}</div></div>
        <div className="stat-cell"><div className="stat-top"><div className="stat-label">最近 30 分钟活跃</div></div><div className="stat-num session-stat-active">{summary.active30m}</div></div>
        <div className="stat-cell"><div className="stat-top"><div className="stat-label">已绑定账号数</div></div><div className="stat-num">{summary.boundAccounts}</div></div>
        <div className="stat-cell"><div className="stat-top"><div className="stat-label">异常绑定数</div></div><div className="stat-num session-stat-error">{summary.abnormal}</div></div>
        <div className="stat-cell"><div className="stat-top"><div className="stat-label">待恢复上游会话</div></div><div className="stat-num session-stat-recoverable">{summary.recoverable}</div></div>
      </div>

      <div className="section-head">
        <div className="section-title">会话列表 <span className="section-count-badge">{filtered.length}</span></div>
      </div>
      <div className="session-toolbar">
        <label className="session-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话 ID 或账号邮箱" />
        </label>
        <select className="input session-account-filter" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
          <option value="all">全部账号</option>
          {accounts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <div className="filter-bar session-filter-bar">
        {filterLabels.map(([key, label]) => (
          <button key={key} className={`filter-chip ${filter === key ? "active" : ""}`} onClick={() => setFilter(key)}>
            {label}<span className="filter-chip-count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="batch-bar">
          <span className="batch-bar-info">已选 <span className="batch-bar-count">{selected.size}</span> 个会话</span>
          <div className="batch-bar-actions">
            <button className="batch-bar-btn" disabled={busy} onClick={() => setConfirm({ mode: "release", ids: [...selected] })}>下次重新分配</button>
            <button className="batch-bar-btn batch-bar-btn-danger" disabled={busy} onClick={() => setConfirm({ mode: "delete", ids: [...selected] })}>清除会话</button>
          </div>
        </div>
      )}

      <div className="table-card accounts-table-card sessions-table-card">
        <table>
          <thead><tr>
            <th style={{ width: 44 }}><label className="checkbox-label"><input type="checkbox" className="checkbox-input" checked={allSelected} onChange={toggleAll}/><span className="checkbox-box"/></label></th>
            <th>会话标识</th><th>绑定账号</th><th className="table-center">账号状态</th><th className="table-center">上游会话</th><th className="table-center">对话轮次</th><th>最近活动</th><th className="table-center">会话状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="empty-state">加载中...</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={9} className="empty-state">暂无符合条件的会话。</td></tr>
              : filtered.map((item) => {
                const status = accountStatus(item);
                const state = sessionState(item);
                return <tr key={item.sessionId} className="session-row" onClick={() => setDetail(item)}>
                  <td onClick={(event) => event.stopPropagation()}><label className={`checkbox-label ${item.isInFlight ? "is-disabled" : ""}`}><input type="checkbox" className="checkbox-input" disabled={item.isInFlight} checked={selected.has(item.sessionId)} onChange={() => toggleOne(item.sessionId)}/><span className="checkbox-box"/></label></td>
                  <td><div className="session-id-cell"><code title={item.sessionId}>{maskSessionId(item.sessionId)}</code><button className="session-copy-btn" title="复制完整会话 ID" onClick={(event) => { event.stopPropagation(); void copyId(item.sessionId); }}><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button></div></td>
                  <td><span className={item.accountEmail ? "session-account" : "session-muted"}>{accountLabel(item)}</span></td>
                  <td className="table-center"><span className={`badge badge-${status.badge}`}>{status.label}</span></td>
                  <td className="table-center"><span className={`badge ${item.hasConversation ? "badge-active" : "badge-disabled"}`}>{item.hasConversation ? "已绑定" : "待恢复"}</span></td>
                  <td className="table-center">{item.turnCount}</td>
                  <td><span className="session-relative" title={formatDate(item.updatedAt)}>{formatRelative(item.updatedAt)}</span></td>
                  <td className="table-center"><span className={`badge session-badge-${state}`}>{sessionStateLabel(item)}</span></td>
                  <td onClick={(event) => event.stopPropagation()}><div className="row-actions session-row-actions">
                    {!item.hasConversation && item.accountId !== null && <button className="session-action-btn session-action-recover" disabled={item.isInFlight || recoveringSessionId !== null} onClick={() => void recoverConversation(item)}>{recoveringSessionId === item.sessionId ? "恢复中..." : "恢复上游"}</button>}
                    <button className="session-action-btn" disabled={item.isInFlight} onClick={() => setConfirm({ mode: "release", ids: [item.sessionId] })}>重新分配</button>
                    <button className="session-action-btn session-action-danger" disabled={item.isInFlight} onClick={() => setConfirm({ mode: "delete", ids: [item.sessionId] })}>清除</button>
                  </div></td>
                </tr>;
              })}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="session-drawer-backdrop" onClick={() => setDetail(null)}>
          <aside className="session-drawer" onClick={(event) => event.stopPropagation()} aria-label="会话详情">
            <div className="session-drawer-header"><div><div className="session-drawer-title">会话详情</div><div className="session-drawer-sub">不展示对话内容</div></div><button className="session-drawer-close" onClick={() => setDetail(null)} aria-label="关闭">×</button></div>
            <div className="session-drawer-body">
              <div className="session-detail-block"><span>完整会话 ID</span><div className="session-detail-id"><code>{detail.sessionId}</code><button onClick={() => void copyId(detail.sessionId)}>复制</button></div></div>
              <dl className="session-detail-list">
                <div><dt>绑定账号</dt><dd>{accountLabel(detail)}</dd></div>
                <div><dt>账号状态</dt><dd>{accountStatus(detail).label}</dd></div>
                <div><dt>Postman 上游会话</dt><dd>{detail.hasConversation ? "已绑定，可直接继续" : "缺失，可尝试从云端历史恢复"}</dd></div>
                {detail.conversationUpdatedAt && <div><dt>上游会话更新时间</dt><dd>{formatDate(detail.conversationUpdatedAt)}</dd></div>}
                <div><dt>会话状态</dt><dd>{sessionStateLabel(detail)}</dd></div>
                <div><dt>对话轮次</dt><dd>{detail.turnCount}</dd></div>
                <div><dt>估算上下文</dt><dd>{detail.estimatedTokens.toLocaleString()} tokens</dd></div>
                <div><dt>消息大小</dt><dd>{detail.messageChars.toLocaleString()} 字符</dd></div>
                <div><dt>修订版本</dt><dd>{detail.revision}</dd></div>
                <div><dt>创建时间</dt><dd>{formatDate(detail.createdAt)}</dd></div>
                <div><dt>最近活动</dt><dd>{formatDate(detail.updatedAt)}</dd></div>
              </dl>
            </div>
            <div className="session-drawer-actions">
              {detail.accountId !== null && detail.accountEmail && <button className="dialog-btn" onClick={() => onViewAccount(detail.accountId!)}>查看账号</button>}
              {!detail.hasConversation && detail.accountId !== null && <button className="dialog-btn dialog-btn-primary" disabled={detail.isInFlight || recoveringSessionId !== null} onClick={() => void recoverConversation(detail)}>{recoveringSessionId === detail.sessionId ? "恢复中..." : "恢复上游会话"}</button>}
              <button className="dialog-btn" disabled={detail.isInFlight} onClick={() => setConfirm({ mode: "release", ids: [detail.sessionId] })}>下次重新分配</button>
              <button className="dialog-btn dialog-btn-danger" disabled={detail.isInFlight} onClick={() => setConfirm({ mode: "delete", ids: [detail.sessionId] })}>清除会话</button>
            </div>
          </aside>
        </div>
      )}

      {confirm && (
        <div className="modal-overlay open" onClick={() => !busy && setConfirm(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">{confirm.mode === "release" ? "下次重新分配" : "清除会话"}</div>
            <div className="dialog-help">{confirm.mode === "release"
              ? `将解除 ${confirm.ids.length} 个会话的账号绑定，保留本地对话上下文；下次请求会自动选择可用账号。`
              : `将删除 ${confirm.ids.length} 个会话的账号绑定和本地上下文。此操作无法撤销。`}</div>
            <div className="dialog-actions"><button className="dialog-btn" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className={`dialog-btn ${confirm.mode === "delete" ? "dialog-btn-danger" : "dialog-btn-primary"}`} disabled={busy} onClick={() => void execute()}>{busy ? "处理中..." : "确认"}</button></div>
          </div>
        </div>
      )}
    </>
  );
}
