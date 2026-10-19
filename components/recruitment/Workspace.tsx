"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  Briefcase,
  Users,
  Calendar,
  FileCheck,
  BarChart3,
  Settings,
  Search,
  Plus,
  Bell,
  ArrowRight,
  Clock,
  CheckCircle2,
  X,
  RefreshCw,
  Columns3,
  List,
  GraduationCap,
  Building2,
  ArrowUpRight,
  ChevronRight,
  Shield,
  FileText,
  Check,
  Circle,
  AlertCircle,
  LogOut,
  ExternalLink,
  ListFilter,
} from "lucide-react";
import type {
  AppState,
  Application,
  Interview,
  Job,
  Snapshot,
  User,
  Stage,
} from "@/lib/domain";
import { STAGES, STAGE_LABELS, ROLE_LABELS } from "@/lib/domain";
import { getMetrics } from "@/lib/metrics";
import Modals from "./Modals";
import SelectionCenter from "./SelectionCenter";
import {
  Avatar,
  Badge,
  Empty,
  Modal,
  Spinner,
  dateTime,
  formatDate,
  jobStatus,
  interviewStatus,
  offerStatus,
  type ModalState,
} from "./ui";

type Page =
  | "overview"
  | "jobs"
  | "applications"
  | "selection"
  | "interviews"
  | "offers"
  | "analytics"
  | "settings";
const navigation = [
  { id: "overview", label: "工作台", icon: LayoutDashboard },
  { id: "jobs", label: "职位管理", icon: Briefcase },
  { id: "applications", label: "候选人与投递", icon: Users },
  { id: "selection", label: "甄选与测评", icon: ListFilter },
  { id: "interviews", label: "面试日程", icon: Calendar },
  { id: "offers", label: "录用与入职", icon: FileCheck },
  { id: "analytics", label: "招聘分析", icon: BarChart3 },
] as const;
const titles: Record<Page, string> = {
  overview: "招聘工作台",
  jobs: "职位管理",
  applications: "候选人与投递",
  selection: "甄选与测评",
  interviews: "面试日程",
  offers: "录用与入职",
  analytics: "招聘分析",
  settings: "演示空间",
};
const stageTone: Record<Stage, string> = {
  new: "neutral",
  screening: "blue",
  interview: "violet",
  offer: "amber",
  onboarding: "teal",
  joined: "green",
};
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const person = (state: AppState, id: string) =>
  state.users.find((u) => u.id === id)?.name || id;
const jobFor = (state: AppState, app: Application) =>
  state.jobs.find((j) => j.id === app.jobId);
function Section({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function StageBadge({ app }: { app: Application }) {
  return (
    <Badge tone={app.status === "closed" ? "neutral" : stageTone[app.stage]}>
      {app.status === "closed" ? "已结束" : STAGE_LABELS[app.stage]}
    </Badge>
  );
}

export default function Workspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [accounts, setAccounts] = useState<User[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [page, setPage] = useState<Page>("overview"),
    [type, setType] = useState<"all" | "social" | "campus">("all"),
    [query, setQuery] = useState(""),
    [jobId, setJobId] = useState(""),
    [batch, setBatch] = useState(""),
    [result, setResult] = useState("all"),
    [board, setBoard] = useState(false),
    [selected, setSelected] = useState(""),
    [detailTab, setDetailTab] = useState("profile"),
    [selectionAppId, setSelectionAppId] = useState(""),
    [agendaFilter, setAgendaFilter] = useState("scheduled"),
    [modal, setModal] = useState<ModalState | null>(null),
    [quick, setQuick] = useState<{
      action: string;
      fields: Record<string, unknown>;
      title: string;
      label: string;
    } | null>(null);
  async function request<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = (await response.json()) as T & { message?: string };
    if (!response.ok) throw new Error(data.message || "请求失败，请重试");
    return data;
  }
  async function refresh() {
    setError("");
    try {
      setSnapshot(await request<Snapshot>("/api/recruitment"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }
  useEffect(() => {
    (async () => {
      try {
        const session = await request<{ user: User | null; users: User[] }>(
          "/api/session",
        );
        setAccounts(session.users || []);
        if (session.user)
          setSnapshot(await request<Snapshot>("/api/recruitment"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previousFocus = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLButtonElement>(".drawer-top button")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") setSelected("");
      if (event.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".detail-drawer button:not(:disabled),.detail-drawer input,.detail-drawer select,.detail-drawer textarea,.detail-drawer a",
          ),
        );
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", escape);
      previousFocus?.focus();
    };
  }, [selected]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function login(userId: string) {
    setBusy(true);
    setError("");
    try {
      await request("/api/session", { userId, password: "Demo2026!" });
      setSnapshot(await request<Snapshot>("/api/recruitment"));
      setSelected("");
      setPage("overview");
      setJobId("");
      setQuery("");
      setType("all");
      setBatch("");
      setResult("all");
      setSelectionAppId("");
      setToast("已切换演示账号");
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  async function action(name: string, fields: Record<string, unknown> = {}) {
    if (!snapshot) throw new Error("请先登录");
    const response = await fetch("/api/recruitment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: name,
        expectedRevision: snapshot.state.revision,
        ...fields,
      }),
    });
    const data = (await response.json()) as Snapshot & { message?: string };
    if (!response.ok) {
      if (response.status === 409) await refresh();
      throw new Error(data.message || "操作未完成");
    }
    setSnapshot(data);
    setToast("已保存，流程记录已更新");
    return data as Snapshot;
  }
  async function run(name: string, fields: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await action(name, fields);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function openApp(id: string) {
    setSelected(id);
    setDetailTab("profile");
  }
  function openSelection(id: string) {
    setSelectionAppId(id);
    setSelected("");
    setPage("selection");
  }
  const state = snapshot?.state,
    user = snapshot?.user;
  const metrics = useMemo(
    () => (state ? getMetrics(state, { type, batch, jobId, query }) : null),
    [state, type, batch, jobId, query],
  );
  if (loading)
    return (
      <div className="startup">
        <div className="brand-icon">T</div>
        <Spinner />
        <p>正在载入招聘空间</p>
      </div>
    );
  if (!snapshot || !state || !user)
    return (
      <main className="login-screen">
        <div className="login-intro">
          <div className="brand">
            <span className="brand-icon">T</span>
            <span>
              拾才 <small>TalentFlow</small>
            </span>
          </div>
          <Badge tone="blue">招聘协作 · 产品 Demo</Badge>
          <h1>
            把招聘的每一步，
            <br />
            接在一起。
          </h1>
          <p>
            从第一份简历到实际入职。
            <br />
            在同一空间，协作完成社招与校招。
          </p>
          <div className="login-flow">
            职位需求 <ArrowRight size={16} /> 人才甄选 <ArrowRight size={16} />{" "}
            面试评估 <ArrowRight size={16} /> 录用入职
          </div>
          <div className="login-foot">
            <Shield size={16} /> 独立角色权限 · 服务端持久化 · 全部合成数据
          </div>
        </div>
        <section className="login-card">
          <div className="eyebrow">YOUR RECRUITING WORKSPACE</div>
          <h2>进入招聘演示空间</h2>
          <p>选择一个角色，体验不同的协作视角。</p>
          <div className="account-options">
            {accounts.map((account) => (
              <button
                key={account.id}
                onClick={() => login(account.id)}
                disabled={busy}
                className={account.role === "hr" ? "primary-account" : ""}
              >
                <Avatar name={account.name} />
                <span>
                  <strong>{account.name}</strong>
                  <small>{ROLE_LABELS[account.role]}</small>
                </span>
                <ArrowRight size={18} />
              </button>
            ))}
          </div>
          {!accounts.length && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => login("hr")}
            >
              以招聘 HR 进入
            </button>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
              <button className="text-button" onClick={() => location.reload()}>
                重新加载
              </button>
            </div>
          )}
          <div className="login-note">
            <InfoIcon />
            这些是公开的演示账号，使用统一测试密码。请勿录入真实个人资料。
          </div>
        </section>
      </main>
    );
  const m = metrics!;
  const isHR = user.role === "hr";
  const visibleJobs = state.jobs.filter(
    (j) => (type === "all" || j.type === type) && (!batch || j.batch === batch),
  );
  const apps = m.filteredApplications.filter(
    (a) => result === "all" || a.status === result,
  );
  const appIds = new Set(m.filteredApplications.map((a) => a.id));
  const interviews = state.interviews
    .filter((i) => appIds.has(i.applicationId))
    .sort((a, b) => a.start.localeCompare(b.start));
  const activeApp = state.applications.find((a) => a.id === selected);
  const activeJob = activeApp ? jobFor(state, activeApp) : null;
  const pendingCards = interviews.filter(
    (i) =>
      i.status === "completed" &&
      i.interviewerIds.some(
        (id) =>
          !state.scorecards.some(
            (c) =>
              c.interviewId === i.id &&
              c.userId === id &&
              c.status === "submitted",
          ),
      ),
  );
  const tasks: Array<{
    label: string;
    note: string;
    appId?: string;
    interviewId?: string;
    kind?: string;
    tone: string;
  }> = [];
  if (user.role === "manager")
    visibleJobs
      .filter((j) => j.status === "pending")
      .forEach((j) =>
        tasks.push({
          label: `确认职位：${j.title}`,
          note: "用人需求等待确认",
          tone: "blue",
        }),
      );
  if (isHR)
    m.filteredApplications
      .filter((a) => a.status === "active" && a.stage === "new")
      .slice(0, 4)
      .forEach((a) =>
        tasks.push({
          label: `初筛 · ${a.snapshot.name}`,
          note: jobFor(state, a)?.title || "",
          appId: a.id,
          tone: "blue",
        }),
      );
  pendingCards.forEach((i) => {
    const app = state.applications.find((a) => a.id === i.applicationId)!;
    const own = i.interviewerIds.includes(user.id);
    tasks.push({
      label: `${own ? "提交评价" : "跟进面试反馈"} · ${app.snapshot.name}`,
      note: `${i.round} · ${dateTime(i.end)}`,
      appId: app.id,
      interviewId: i.id,
      kind: own ? "scorecard" : undefined,
      tone: "amber",
    });
  });
  if (isHR)
    m.filteredApplications
      .filter((a) => a.status === "active" && a.stage === "onboarding")
      .forEach((a) =>
        tasks.push({
          label: `入职跟进 · ${a.snapshot.name}`,
          note: `计划 ${formatDate(a.plannedJoinDate)}`,
          appId: a.id,
          tone: "teal",
        }),
      );
  const todayLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  const table = (items: Application[], compact = false) => (
    <div className="table-scroll">
      <table className={`data-table ${compact ? "compact" : ""}`}>
        <thead>
          <tr>
            <th>候选人</th>
            <th>应聘职位</th>
            {!compact && <th>招聘类型</th>}
            <th>招聘阶段</th>
            <th>来源渠道</th>
            <th>最近更新</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>
                <button className="person-button" onClick={() => openApp(a.id)}>
                  <Avatar name={a.snapshot.name} />
                  <span>
                    <strong>{a.snapshot.name}</strong>
                    <small>
                      {a.snapshot.school || a.snapshot.major || "社会人才"}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <span className="job-name">{jobFor(state, a)?.title}</span>
                {!compact && (
                  <small className="cell-sub">
                    {jobFor(state, a)?.batch || jobFor(state, a)?.department}
                  </small>
                )}
              </td>
              {!compact && (
                <td>
                  <Badge
                    tone={
                      jobFor(state, a)?.type === "campus" ? "violet" : "blue"
                    }
                  >
                    {jobFor(state, a)?.type === "campus" ? "校招" : "社招"}
                  </Badge>
                </td>
              )}
              <td>
                <StageBadge app={a} />
              </td>
              <td className="muted">{a.source}</td>
              <td className="muted mono">{formatDate(a.updatedAt)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`查看${a.snapshot.name}`}
                  onClick={() => openApp(a.id)}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <Empty text="没有符合条件的投递记录">
          <button
            className="text-button"
            onClick={() => {
              setQuery("");
              setJobId("");
              setBatch("");
              setResult("all");
            }}
          >
            清除筛选条件
          </button>
        </Empty>
      )}
    </div>
  );
  const agenda = (items: Interview[]) =>
    items.length ? (
      <div className="agenda-list">
        {items.map((i) => {
          const app = state.applications.find((a) => a.id === i.applicationId)!;
          const own = i.interviewerIds.includes(user.id);
          const dateParts = new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
            month: "numeric",
            day: "2-digit",
            weekday: "short",
          }).formatToParts(new Date(i.start));
          const datePart = (type: string) =>
            dateParts.find((p) => p.type === type)?.value || "";
          const time = (value: string) =>
            new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date(value));
          return (
            <div className="agenda-item" key={i.id}>
              <time
                className="date-tile"
                dateTime={i.start}
                aria-label={formatDate(i.start, {
                  year: "numeric",
                  weekday: "long",
                })}
              >
                <span>{datePart("month")}月</span>
                <strong>{datePart("day")}</strong>
                <small>{datePart("weekday")}</small>
              </time>
              <div className="agenda-body">
                <div className="agenda-title">
                  <button onClick={() => openApp(app.id)}>
                    {app.snapshot.name}
                  </button>
                  <Badge
                    tone={
                      i.status === "scheduled"
                        ? "blue"
                        : i.status === "completed"
                          ? "green"
                          : "neutral"
                    }
                  >
                    {interviewStatus[i.status]}
                  </Badge>
                </div>
                <p>
                  {jobFor(state, app)?.title} · {i.round}
                </p>
                <small>
                  <Clock size={12} />
                  <span className="agenda-time">
                    {time(i.start)}–{time(i.end)}
                  </span>
                  <span className="agenda-location">{i.location}</span>
                </small>
                <small>
                  面试官：
                  {i.interviewerIds.map((id) => person(state, id)).join("、")}
                </small>
              </div>
              <div className="agenda-actions">
                <button
                  className="button small"
                  onClick={() => {
                    openApp(app.id);
                    setDetailTab("interviews");
                  }}
                >
                  查看详情
                  <ChevronRight size={13} />
                </button>
                {isHR && i.status === "scheduled" && (
                  <>
                    <button
                      className="button small"
                      onClick={() =>
                        run("interviewStatus", {
                          interviewId: i.id,
                          status: "completed",
                        })
                      }
                    >
                      确认完成
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        setModal({
                          kind: "reschedule",
                          interviewId: i.id,
                          applicationId: app.id,
                        })
                      }
                    >
                      改期
                    </button>
                    <button
                      className="text-button muted"
                      onClick={() =>
                        run("interviewStatus", {
                          interviewId: i.id,
                          status: "cancelled",
                        })
                      }
                    >
                      取消
                    </button>
                    {!i.notified && (
                      <button
                        className="text-button"
                        onClick={() =>
                          run("notifyInterview", { interviewId: i.id })
                        }
                      >
                        标记已人工通知
                      </button>
                    )}
                  </>
                )}
                {own && i.status === "completed" && (
                  <button
                    className="button small primary"
                    onClick={() => {
                      if (
                        state.scorecards.some(
                          (c) =>
                            c.interviewId === i.id &&
                            c.userId === user.id &&
                            c.status === "submitted",
                        )
                      ) {
                        openApp(app.id);
                        setDetailTab("interviews");
                      } else setModal({ kind: "scorecard", interviewId: i.id });
                    }}
                  >
                    {state.scorecards.some(
                      (c) =>
                        c.interviewId === i.id &&
                        c.userId === user.id &&
                        c.status === "submitted",
                    )
                      ? "查看已交评价"
                      : "填写评价"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    ) : (
      <Empty text="当前筛选下没有面试安排" />
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage("overview")}>
          <span className="brand-icon">T</span>
          <span>
            拾才<small>TalentFlow</small>
          </span>
        </button>
        <div className="space-label">
          <span className="workspace-dot" /> 招聘协作空间 <Badge>Demo</Badge>
        </div>
        <div className="nav-caption">招聘管理</div>
        <nav>
          {navigation
            .filter(
              (item) =>
                item.id !== "selection" ||
                user.role === "hr" ||
                user.role === "manager",
            )
            .map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                aria-label={label}
                onClick={() => {
                  setPage(id);
                  setJobId("");
                  setResult("all");
                }}
                className={page === id ? "active" : ""}
              >
                <Icon size={18} />
                <span>{label}</span>
                {id === "applications" && <b>{state.applications.length}</b>}
                {id === "interviews" && pendingCards.length > 0 && <i />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-callout">
            <span className="demo-spark">✳</span>
            <strong>为更好的招聘协作</strong>
            <p>社招与校招，同一条人才链路。</p>
            <button onClick={() => setPage("settings")}>
              查看演示说明 <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className={
              page === "settings" ? "settings-link active" : "settings-link"
            }
            onClick={() => setPage("settings")}
          >
            <Settings size={17} />
            演示与设置
          </button>
          <div className="sidebar-user">
            <Avatar name={user.name} />
            <div>
              <strong>{user.name}</strong>
              <small>{ROLE_LABELS[user.role]}</small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />
            <strong>{titles[page]}</strong>
          </div>
          <div className="top-actions">
            <span className="synthetic-label">
              <span />
              合成数据演示
            </span>
            <button
              className="icon-button"
              aria-label="刷新招聘数据"
              disabled={busy}
              onClick={() => refresh()}
            >
              <RefreshCw size={17} />
            </button>
            <button
              className="icon-button notification-button"
              aria-label="查看待办"
              onClick={() => setPage("overview")}
            >
              <Bell size={18} />
              {tasks.length > 0 && <i />}
            </button>
            <select
              className="account-select"
              aria-label="切换演示账号"
              value={user.id}
              disabled={busy}
              onChange={(e) => login(e.target.value)}
            >
              {accounts.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {ROLE_LABELS[u.role]}
                </option>
              ))}
            </select>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "overview" ? todayLabel : "TALENT ACQUISITION"}
              </div>
              <h1>
                {titles[page]}
                {page === "overview" && <span className="heading-dot" />}
              </h1>
              <p>
                {
                  {
                    overview: "看清招聘进展，把精力留给合适的人。",
                    jobs: "让用人需求、招聘标准与业务团队保持一致。",
                    applications:
                      "一个人才档案，多次独立投递，每一步都有依据。",
                    selection: "从条件核对到能力评估，让每一步甄选都有证据。",
                    interviews: "协调每一场面试，及时沉淀每一份评价。",
                    offers: "从录用意向到实际到岗，分别确认每一个结果。",
                    analytics: "用一致的数据口径，找到招聘流程中的改进机会。",
                    settings: "了解演示能力与角色边界，安全地体验完整流程。",
                  }[page]
                }
              </p>
            </div>
            <div className="heading-actions">
              {isHR && page === "jobs" && (
                <button
                  className="button primary"
                  onClick={() => setModal({ kind: "job" })}
                >
                  <Plus size={16} />
                  创建职位
                </button>
              )}
              {isHR && ["overview", "applications"].includes(page) && (
                <>
                  <button
                    className="button"
                    onClick={() => setModal({ kind: "import" })}
                  >
                    批量导入
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setModal({ kind: "candidate" })}
                  >
                    <Plus size={16} />
                    添加候选人
                  </button>
                </>
              )}
            </div>
          </div>
          {error && (
            <div className="form-error">
              {error}
              <button className="text-button" onClick={() => refresh()}>
                重试加载
              </button>
            </div>
          )}
          {page !== "settings" && page !== "selection" && (
            <div className="filter-bar">
              <div className="type-tabs">
                {(["all", "social", "campus"] as const).map((t) => (
                  <button
                    key={t}
                    className={type === t ? "active" : ""}
                    onClick={() => {
                      setType(t);
                      setJobId("");
                      setBatch("");
                    }}
                  >
                    {t === "all"
                      ? "全部招聘"
                      : t === "social"
                        ? "社会招聘"
                        : "校园招聘"}
                    {t === "campus" && <GraduationCap size={15} />}
                  </button>
                ))}
              </div>
              <div className="filter-right">
                {type === "campus" && (
                  <select
                    aria-label="校招批次"
                    value={batch}
                    onChange={(e) => setBatch(e.target.value)}
                  >
                    <option value="">全部批次</option>
                    {[
                      ...new Set(
                        state.jobs
                          .filter((j) => j.type === "campus")
                          .map((j) => j.batch),
                      ),
                    ].map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                )}
                <label className="search-box">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索姓名、职位或技能"
                    aria-label="搜索姓名、职位或技能"
                  />
                  {query && (
                    <button aria-label="清空搜索" onClick={() => setQuery("")}>
                      <X size={13} />
                    </button>
                  )}
                </label>
              </div>
            </div>
          )}
          {user.role === "admin" && page !== "settings" ? (
            <Section
              title="系统管理员视角"
              subtitle="管理账号不等于获得招聘资料访问权。"
            >
              <div className="permission-state">
                <Shield size={40} />
                <h3>招聘业务资料已隔离</h3>
                <p>可切换招聘 HR、用人经理或面试官体验对应任务。</p>
                <button
                  className="button primary"
                  onClick={() => setPage("settings")}
                >
                  查看角色说明
                </button>
              </div>
            </Section>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="stats-grid">
                    {[
                      {
                        label: "招聘中职位",
                        value: m.openJobs,
                        sub: `${visibleJobs.filter((j) => j.status === "pending").length} 个需求待确认`,
                        icon: Briefcase,
                        tone: "blue",
                      },
                      {
                        label: "进行中投递",
                        value: m.active,
                        sub: `${m.people} 位候选人 · ${m.total} 次投递`,
                        icon: Users,
                        tone: "violet",
                      },
                      {
                        label: "待完成面试",
                        value: interviews.filter(
                          (i) => i.status === "scheduled",
                        ).length,
                        sub: `${pendingCards.length} 场面试待收齐评价`,
                        icon: Calendar,
                        tone: "amber",
                      },
                      {
                        label: "已确认入职",
                        value: m.joined,
                        sub: `${m.filteredApplications.filter((a) => a.stage === "onboarding" && a.status === "active").length} 人待入职跟进`,
                        icon: CheckCircle2,
                        tone: "teal",
                      },
                    ].map((x) => (
                      <div className="stat-card" key={x.label}>
                        <span className={`stat-icon tone-${x.tone}`}>
                          <x.icon size={20} />
                        </span>
                        <span className="stat-label">{x.label}</span>
                        <strong>
                          {x.value}
                          <small>
                            {x.label.includes("职位")
                              ? "个"
                              : x.label.includes("投递")
                                ? "份"
                                : x.label.includes("面试")
                                  ? "场"
                                  : "人"}
                          </small>
                        </strong>
                        <p>{x.sub}</p>
                      </div>
                    ))}
                  </div>
                  <div className="overview-grid">
                    <div className="overview-main">
                      <Section
                        title="招聘进度"
                        subtitle="最近更新的投递，及时衔接下一步"
                        action={
                          <button
                            className="text-button"
                            onClick={() => setPage("applications")}
                          >
                            查看全部 <ArrowRight size={14} />
                          </button>
                        }
                      >
                        {table(
                          [...m.filteredApplications]
                            .sort((a, b) =>
                              b.updatedAt.localeCompare(a.updatedAt),
                            )
                            .slice(0, 6),
                          true,
                        )}
                      </Section>
                      <Section
                        title="近期面试"
                        subtitle="系统内安排 · 通知由 HR 人工确认"
                        action={
                          <button
                            className="text-button"
                            onClick={() => setPage("interviews")}
                          >
                            面试日程 <ArrowRight size={14} />
                          </button>
                        }
                      >
                        {agenda(
                          interviews
                            .filter((i) => i.status === "scheduled")
                            .slice(0, 3),
                        )}
                      </Section>
                    </div>
                    <div className="overview-side">
                      <Section
                        title="待办事项"
                        action={<Badge tone="amber">{tasks.length} 项</Badge>}
                      >
                        {tasks.length ? (
                          <div className="task-list">
                            {tasks.slice(0, 6).map((task, index) => (
                              <button
                                key={index}
                                className="task-item"
                                onClick={() =>
                                  task.kind
                                    ? setModal({
                                        kind: task.kind,
                                        interviewId: task.interviewId,
                                      })
                                    : task.appId
                                      ? openApp(task.appId)
                                      : setPage("jobs")
                                }
                              >
                                <span className={`task-mark tone-${task.tone}`}>
                                  <Circle size={14} />
                                </span>
                                <span>
                                  <strong>{task.label}</strong>
                                  <small>{task.note}</small>
                                </span>
                                <ChevronRight size={14} />
                              </button>
                            ))}
                          </div>
                        ) : (
                          <Empty text="当前没有待处理任务" />
                        )}
                      </Section>
                      <Section
                        title="招聘转化"
                        subtitle="同一批投递累计到达各阶段"
                      >
                        <div className="mini-funnel">
                          {m.funnel.map((f, i) => (
                            <div key={f.stage}>
                              <span>{f.label}</span>
                              <div>
                                <i
                                  style={{
                                    width: `${m.total && f.count > 0 ? Math.max(3, (f.count / m.total) * 100) : 0}%`,
                                    opacity: 1 - i * 0.1,
                                  }}
                                />
                              </div>
                              <strong>{f.count}</strong>
                            </div>
                          ))}
                        </div>
                        <button
                          className="funnel-link"
                          onClick={() => setPage("analytics")}
                        >
                          查看详细分析 <ArrowUpRight size={15} />
                        </button>
                      </Section>
                      <div className="insight-note">
                        <ListChecksIcon />
                        <div>
                          <strong>让每次判断都有依据</strong>
                          <p>先核对岗位条件，再结合测评证据，记录人工结论。</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {page === "jobs" && (
                <>
                  <div className="subtoolbar">
                    <p>
                      共 <strong>{visibleJobs.length}</strong> 个职位 ·{" "}
                      {visibleJobs.filter((j) => j.status === "open").length}{" "}
                      个招聘中
                    </p>
                    <Badge>用人确认 ≠ 预算审批</Badge>
                  </div>
                  <div className="jobs-grid">
                    {visibleJobs
                      .filter(
                        (j) =>
                          !query ||
                          [j.title, j.department, ...j.skills]
                            .join(" ")
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                      )
                      .map((j) => {
                        const ja = state.applications.filter(
                          (a) => a.jobId === j.id,
                        );
                        return (
                          <article className="job-card" key={j.id}>
                            <div className="job-card-top">
                              <span
                                className={`job-type-icon tone-${j.type === "campus" ? "violet" : "blue"}`}
                              >
                                {j.type === "campus" ? (
                                  <GraduationCap size={22} />
                                ) : (
                                  <Briefcase size={22} />
                                )}
                              </span>
                              <Badge
                                tone={
                                  j.status === "open"
                                    ? "green"
                                    : j.status === "pending"
                                      ? "amber"
                                      : "neutral"
                                }
                              >
                                {jobStatus[j.status]}
                              </Badge>
                            </div>
                            <button
                              className="job-title"
                              onClick={() => {
                                setJobId(j.id);
                                setPage("applications");
                              }}
                            >
                              {j.title}
                            </button>
                            <p className="job-meta">
                              {j.department} <span /> {j.location} <span />{" "}
                              {j.type === "campus" ? "校园招聘" : "社会招聘"}
                            </p>
                            {j.type === "campus" && (
                              <p className="batch-line">
                                {j.batch} · {j.graduationYears.join(" / ")} 届
                              </p>
                            )}
                            <div className="skill-tags">
                              {j.skills.slice(0, 4).map((s) => (
                                <span key={s}>{s}</span>
                              ))}
                            </div>
                            <p className="job-description">{j.description}</p>
                            <div className="job-numbers">
                              <div>
                                <strong>{ja.length}</strong>
                                <small>收到投递</small>
                              </div>
                              <div>
                                <strong>
                                  {
                                    ja.filter((a) => a.status === "active")
                                      .length
                                  }
                                </strong>
                                <small>进行中</small>
                              </div>
                              <div>
                                <strong>
                                  {
                                    ja.filter((a) => a.status === "joined")
                                      .length
                                  }
                                  <em> / {j.headcount}</em>
                                </strong>
                                <small>已入职 / 需求</small>
                              </div>
                            </div>
                            <div className="job-card-footer">
                              <span>负责人 {person(state, j.ownerId)}</span>
                              <div>
                                {isHR && j.status === "draft" && (
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      run("jobStatus", {
                                        jobId: j.id,
                                        status: "pending",
                                      })
                                    }
                                  >
                                    提交确认
                                  </button>
                                )}
                                {user.role === "manager" &&
                                  j.status === "pending" && (
                                    <>
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          setQuick({
                                            action: "jobStatus",
                                            fields: {
                                              jobId: j.id,
                                              status: "draft",
                                            },
                                            title: "退回职位需求",
                                            label: "退回原因",
                                          })
                                        }
                                      >
                                        退回
                                      </button>
                                      <button
                                        className="button small primary"
                                        onClick={() =>
                                          run("jobStatus", {
                                            jobId: j.id,
                                            status: "open",
                                          })
                                        }
                                      >
                                        确认招聘
                                      </button>
                                    </>
                                  )}
                                {isHR && j.status === "open" && (
                                  <button
                                    className="text-button muted"
                                    onClick={() =>
                                      run("jobStatus", {
                                        jobId: j.id,
                                        status: "paused",
                                      })
                                    }
                                  >
                                    暂停
                                  </button>
                                )}
                                {isHR && j.status === "paused" && (
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      run("jobStatus", {
                                        jobId: j.id,
                                        status: "open",
                                      })
                                    }
                                  >
                                    恢复
                                  </button>
                                )}
                                {isHR &&
                                  ["paused", "open"].includes(j.status) && (
                                    <button
                                      className="text-button muted"
                                      onClick={() =>
                                        run("jobStatus", {
                                          jobId: j.id,
                                          status: "closed",
                                        })
                                      }
                                    >
                                      关闭
                                    </button>
                                  )}
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setJobId(j.id);
                                    setPage("applications");
                                  }}
                                >
                                  投递 <ArrowRight size={13} />
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                  </div>
                  {!visibleJobs.length && <Empty text="该范围没有职位" />}
                </>
              )}
              {page === "applications" && (
                <Section
                  title="投递列表"
                  subtitle={`${m.people} 位候选人 · ${apps.length} 次投递，跨岗位进度独立`}
                  action={
                    <div className="view-toggle">
                      <button
                        aria-label="列表视图"
                        className={!board ? "active" : ""}
                        onClick={() => setBoard(false)}
                      >
                        <List size={17} />
                      </button>
                      <button
                        aria-label="看板视图"
                        className={board ? "active" : ""}
                        onClick={() => setBoard(true)}
                      >
                        <Columns3 size={17} />
                      </button>
                    </div>
                  }
                >
                  <div className="list-toolbar">
                    <select
                      aria-label="筛选职位"
                      value={jobId}
                      onChange={(e) => setJobId(e.target.value)}
                    >
                      <option value="">全部职位</option>
                      {visibleJobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.title}
                        </option>
                      ))}
                    </select>
                    <div className="small-tabs">
                      {[
                        ["all", "全部"],
                        ["active", "进行中"],
                        ["joined", "已入职"],
                        ["closed", "已结束"],
                      ].map(([value, label]) => (
                        <button
                          className={result === value ? "active" : ""}
                          key={value}
                          onClick={() => setResult(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {board ? (
                    <div className="kanban">
                      {STAGES.map((stage) => (
                        <div className="kanban-column" key={stage}>
                          <h3>
                            <span
                              className={`stage-dot tone-${stageTone[stage]}`}
                            />
                            {STAGE_LABELS[stage]}
                            <b>
                              {apps.filter((a) => a.stage === stage).length}
                            </b>
                          </h3>
                          {apps
                            .filter((a) => a.stage === stage)
                            .map((a) => (
                              <button
                                className="kanban-card"
                                key={a.id}
                                onClick={() => openApp(a.id)}
                              >
                                <div>
                                  <Avatar name={a.snapshot.name} small />
                                  <strong>{a.snapshot.name}</strong>
                                  {a.status === "closed" && (
                                    <small>已结束</small>
                                  )}
                                </div>
                                <p>{jobFor(state, a)?.title}</p>
                                <div className="skill-tags">
                                  {a.snapshot.skills.slice(0, 2).map((s) => (
                                    <span key={s}>{s}</span>
                                  ))}
                                </div>
                                <footer>
                                  {a.source}
                                  <small>{formatDate(a.updatedAt)}</small>
                                </footer>
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    table(apps)
                  )}
                </Section>
              )}
              {page === "interviews" && (
                <>
                  <div className="agenda-summary">
                    <div>
                      <Calendar size={20} />
                      <span>
                        待进行
                        <strong>
                          {
                            interviews.filter((i) => i.status === "scheduled")
                              .length
                          }
                          <small> 场</small>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <FileText size={20} />
                      <span>
                        待收齐评价
                        <strong>
                          {pendingCards.length}
                          <small> 场</small>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <CheckCircle2 size={20} />
                      <span>
                        已完成
                        <strong>
                          {
                            interviews.filter((i) => i.status === "completed")
                              .length
                          }
                          <small> 场</small>
                        </strong>
                      </span>
                    </div>
                  </div>
                  <Section
                    title="面试安排与反馈"
                    subtitle="北京时间 · 从候选人详情安排面试，通知由 HR 人工确认"
                    action={
                      <Badge tone="blue">{interviews.length} 场记录</Badge>
                    }
                  >
                    <div className="agenda-toolbar">
                      <div
                        className="agenda-view-tabs"
                        role="group"
                        aria-label="面试记录状态"
                      >
                        {[
                          ["scheduled", "待进行"],
                          ["feedback", "待评价"],
                          ["completed", "已完成"],
                          ["all", "全部记录"],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            aria-pressed={agendaFilter === value}
                            className={agendaFilter === value ? "active" : ""}
                            onClick={() => setAgendaFilter(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <span>按面试时间排列</span>
                    </div>
                    {agenda(
                      interviews
                        .filter(
                          (i) =>
                            agendaFilter === "all" ||
                            (agendaFilter === "feedback"
                              ? pendingCards.some((p) => p.id === i.id)
                              : i.status === agendaFilter),
                        )
                        .sort((a, b) =>
                          agendaFilter === "completed"
                            ? b.start.localeCompare(a.start)
                            : a.start.localeCompare(b.start),
                        ),
                    )}
                  </Section>
                </>
              )}
              {page === "selection" && (
                <SelectionCenter
                  state={state}
                  user={user}
                  onAction={action}
                  initialApplicationId={selectionAppId}
                />
              )}
              {page === "offers" && (
                <Section
                  title="录用与入职台账"
                  subtitle="发出、接受、校招协议和实际到岗，分别登记"
                >
                  <div className="offer-stage-summary">
                    <div>
                      <span>Offer 已发出</span>
                      <strong>{m.offerSent}</strong>
                    </div>
                    <ArrowRight size={18} />
                    <div>
                      <span>已接受</span>
                      <strong>{m.offerAccepted}</strong>
                    </div>
                    <ArrowRight size={18} />
                    <div>
                      <span>实际入职</span>
                      <strong>{m.joined}</strong>
                    </div>
                    <p>
                      接受 Offer 后仍需确认实际入职，
                      <br />
                      校招协议登记不会自动增加入职数。
                    </p>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>候选人 / 职位</th>
                          <th>Offer 状态</th>
                          <th>答复截止</th>
                          <th>计划入职</th>
                          <th>协议台账</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.filteredApplications
                          .filter((a) => a.offer.status !== "none")
                          .map((a) => (
                            <tr key={a.id}>
                              <td>
                                <button
                                  className="person-button"
                                  onClick={() => openApp(a.id)}
                                >
                                  <Avatar name={a.snapshot.name} />
                                  <span>
                                    <strong>{a.snapshot.name}</strong>
                                    <small>{jobFor(state, a)?.title}</small>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <Badge
                                  tone={
                                    a.status === "joined"
                                      ? "green"
                                      : a.offer.status === "accepted"
                                        ? "teal"
                                        : a.offer.status === "sent"
                                          ? "amber"
                                          : "neutral"
                                  }
                                >
                                  {a.status === "joined"
                                    ? "已入职"
                                    : offerStatus[a.offer.status]}
                                </Badge>
                              </td>
                              <td>{formatDate(a.offer.deadline)}</td>
                              <td>{formatDate(a.plannedJoinDate)}</td>
                              <td>
                                {jobFor(state, a)?.type === "campus"
                                  ? a.agreement.status === "signed"
                                    ? "已登记签署"
                                    : a.agreement.status === "waived"
                                      ? "不适用"
                                      : "待办理"
                                  : "—"}
                              </td>
                              <td>
                                <div className="row-actions">
                                  {isHR &&
                                    a.status === "active" &&
                                    a.offer.status === "sent" && (
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          setModal({
                                            kind: "offerResponse",
                                            applicationId: a.id,
                                          })
                                        }
                                      >
                                        登记答复
                                      </button>
                                    )}
                                  {isHR &&
                                    a.status === "active" &&
                                    a.stage === "onboarding" && (
                                      <>
                                        <button
                                          className="text-button"
                                          onClick={() =>
                                            setModal({
                                              kind: "join",
                                              applicationId: a.id,
                                            })
                                          }
                                        >
                                          确认入职
                                        </button>
                                        {jobFor(state, a)?.type ===
                                          "campus" && (
                                          <button
                                            className="text-button"
                                            onClick={() =>
                                              setModal({
                                                kind: "agreement",
                                                applicationId: a.id,
                                              })
                                            }
                                          >
                                            协议
                                          </button>
                                        )}
                                      </>
                                    )}
                                  <button
                                    className="icon-button"
                                    aria-label={`查看${a.snapshot.name}录用记录`}
                                    onClick={() => openApp(a.id)}
                                  >
                                    <ChevronRight size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              )}
              {page === "analytics" && (
                <>
                  <div className="analytics-banner">
                    <div>
                      <span className="eyebrow">清晰的口径，可靠的判断</span>
                      <h2>从投递到入职，看见每一步转化。</h2>
                      <p>
                        当前权限与筛选范围 · 截止{" "}
                        {dateTime(new Date().toISOString())} · 全量建档 cohort
                      </p>
                    </div>
                    <BarChart3 size={62} strokeWidth={1} />
                  </div>
                  <div className="analytics-kpis">
                    <div>
                      <span>累计投递</span>
                      <strong>{m.total}</strong>
                      <small>{m.people} 位独立候选人</small>
                    </div>
                    <div>
                      <span>整体入职转化</span>
                      <strong>
                        {percent(m.total ? m.joined / m.total : null)}
                      </strong>
                      <small>
                        {m.joined} / {m.total} 次投递
                      </small>
                    </div>
                    <div>
                      <span>Offer 接受率</span>
                      <strong>{percent(m.offerAcceptanceRate)}</strong>
                      <small>仅接受 / 明确答复；已发出 {m.offerSent}</small>
                    </div>
                    <div>
                      <span>24 小时反馈及时率</span>
                      <strong>{percent(m.feedbackRate)}</strong>
                      <small>
                        {m.feedbackTimely} / {m.feedbackDue} 份成熟评价
                      </small>
                    </div>
                  </div>
                  <div className="analysis-grid">
                    <Section
                      title="同批投递转化漏斗"
                      subtitle="累计到达阶段，不是当前阶段人数"
                    >
                      <div className="large-funnel">
                        {m.funnel.map((f, i) => (
                          <div className="funnel-row" key={f.stage}>
                            <span>
                              <i>{String(i + 1).padStart(2, "0")}</i>
                              {f.label}
                            </span>
                            <div className="funnel-track">
                              <div
                                style={{
                                  width: `${m.total && f.count > 0 ? Math.max(2, (f.count / m.total) * 100) : 0}%`,
                                }}
                              />
                            </div>
                            <strong>{f.count}</strong>
                            <small>{percent(f.conversion)}</small>
                          </div>
                        ))}
                      </div>
                      <div className="chart-note">
                        每次投递在每个阶段最多计一次；未完成观察的投递仍在流程中。相邻转化显示为下一阶段
                        / 上一阶段。
                      </div>
                    </Section>
                    <Section title="渠道来源" subtitle="按投递首触来源归因">
                      <div className="source-list">
                        {m.sources.map((s, i) => (
                          <div className="source-row" key={s.source}>
                            <span className="source-rank">{i + 1}</span>
                            <div>
                              <strong>{s.source}</strong>
                              <div className="source-track">
                                <i
                                  style={{
                                    width: `${m.total ? (s.count / m.total) * 100 : 0}%`,
                                  }}
                                />
                              </div>
                            </div>
                            <strong>
                              {s.count}
                              <small>{s.joined} 入职</small>
                            </strong>
                          </div>
                        ))}
                      </div>
                    </Section>
                  </div>
                  <Section title="数据说明">
                    <div className="definition-grid">
                      <div>
                        <h3>人数与投递分别计算</h3>
                        <p>
                          同一个人可以申请不同岗位，各次申请拥有独立进度、评价和结果。
                        </p>
                      </div>
                      <div>
                        <h3>未知不代表零</h3>
                        <p>
                          零分母显示“—”。首次处理时长中位数为{" "}
                          {m.firstResponseHours === null
                            ? "—"
                            : `${m.firstResponseHours.toFixed(1)} 小时`}
                          ，未处理样本另作积压。
                        </p>
                      </div>
                      <div>
                        <h3>速度不等于招聘质量</h3>
                        <p>
                          当前只有招聘过程数据；试用期表现、留任与实际招聘质量尚未接入。
                        </p>
                      </div>
                    </div>
                  </Section>
                </>
              )}
              {page === "settings" && (
                <>
                  <Section
                    title="这是一个可操作的招聘 Demo"
                    subtitle="使用合成资料体验流程与协作，数据通过服务端保存。"
                  >
                    <div className="definition-grid">
                      <div>
                        <Shield size={22} />
                        <h3>角色权限</h3>
                        <p>
                          HR
                          负责流程，经理确认需求与录用，面试官只看分配的任务。管理员默认无招聘资料权限。
                        </p>
                      </div>
                      <div>
                        <FileCheck size={22} />
                        <h3>结果分别确认</h3>
                        <p>
                          接受
                          Offer、登记校招协议和实际入职互相独立，不自动将录用意向计为实际入职。
                        </p>
                      </div>
                      <div>
                        <Building2 size={22} />
                        <h3>小规模演示存储</h3>
                        <p>
                          D1 保存业务对象集合，revision
                          防止并发覆盖。尚未实现生产规范化表、企业 SSO
                          与完整资料治理。
                        </p>
                      </div>
                    </div>
                  </Section>
                  <Section
                    title="分层甄选能力"
                    subtitle="回应规则初筛、AI 复筛、HR 复核与多轮能力评估"
                  >
                    <div className="capability-list">
                      {[
                        [
                          "规则核对",
                          "已实现",
                          "blue",
                          "配置最低学历、必需技能与届别；逐项给出符合、未符合或待核实，不自动淘汰。",
                        ],
                        [
                          "HR 复核",
                          "已实现",
                          "blue",
                          "人工记录筛选结论和证据，决定推进或结束。",
                        ],
                        [
                          "结构化面试评价",
                          "已实现",
                          "blue",
                          "先独立提交，再看同伴评价，经理综合决策。",
                        ],
                        [
                          "AI 简历复筛",
                          "规则演示",
                          "violet",
                          "可生成并保存匹配报告、原文证据和缺口。当前用固定规则模拟，未调用真实模型。",
                        ],
                        [
                          "工作偏好问卷与笔试",
                          "已实现",
                          "blue",
                          "支持指派、作答和报告。笔试按标准答案判分；工作偏好问卷用于交流，不输出录用总分。",
                        ],
                        [
                          "AI 面试与辅助评分",
                          "规则演示",
                          "violet",
                          "文本问答与固定规则评分可操作；独立人工评价提交后可核对证据，不改写人工分数。真实模型待接入。",
                        ],
                      ].map(([title, status, tone, desc]) => (
                        <div key={title}>
                          <span>
                            <strong>{title}</strong>
                            <p>{desc}</p>
                          </span>
                          <Badge tone={tone}>{status}</Badge>
                        </div>
                      ))}
                    </div>
                    <a
                      className="document-link"
                      href="https://chatgpt.com/space/page_e223fdade85c819197499dc0eca1d81e"
                      target="_blank"
                      rel="noreferrer"
                    >
                      阅读分层甄选设计补充 <ExternalLink size={15} />
                    </a>
                  </Section>
                  <Section title="外部服务与演示账号">
                    <div className="settings-details">
                      <p>
                        面试仅在系统内安排，通知由 HR
                        人工确认。邮件、短信、外部日历、招聘渠道、电子签约、背调与
                        HRIS 均未接入。所有账号使用公开测试密码{" "}
                        <code>Demo2026!</code>，请勿录入真实资料。
                      </p>
                      <div className="account-list">
                        {state.users.map((u) => (
                          <div key={u.id}>
                            <Avatar name={u.name} />
                            <span>
                              <strong>{u.name}</strong>
                              <small>
                                {ROLE_LABELS[u.role]} · {u.id}
                              </small>
                            </span>
                            <button
                              className="button small"
                              disabled={u.id === user.id || busy}
                              onClick={() => login(u.id)}
                            >
                              {u.id === user.id ? "当前账号" : "切换体验"}
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="settings-footer">
                        {isHR && (
                          <button
                            className="button danger-outline"
                            onClick={() => setModal({ kind: "reset" })}
                          >
                            <RefreshCw size={15} />
                            重置合成演示数据
                          </button>
                        )}
                        <button
                          className="button"
                          onClick={async () => {
                            await fetch("/api/session", { method: "DELETE" });
                            setSnapshot(null);
                          }}
                        >
                          <LogOut size={15} />
                          退出演示账号
                        </button>
                      </div>
                    </div>
                  </Section>
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>TalentFlow · 招聘协作工作台</span>
            <span>合成数据 · 北京时间 · 数据版本 {state.revision}</span>
          </footer>
        </main>
      </div>
      {activeApp && activeJob && (
        <div className="drawer-overlay" onClick={() => setSelected("")}>
          <aside
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`${activeApp.snapshot.name}投递详情`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <span>
                投递详情 <small>{activeApp.id.slice(-8).toUpperCase()}</small>
              </span>
              <button
                className="icon-button"
                aria-label="关闭投递详情"
                onClick={() => setSelected("")}
              >
                <X size={20} />
              </button>
            </div>
            <div className="candidate-heading">
              <Avatar name={activeApp.snapshot.name} />
              <div>
                <h2>
                  {activeApp.snapshot.name}
                  <StageBadge app={activeApp} />
                </h2>
                <p>
                  {activeJob.title} ·{" "}
                  {activeJob.type === "campus" ? "校园招聘" : "社会招聘"}
                </p>
              </div>
            </div>
            <div className="pipeline-strip">
              {STAGES.map((s, i) => (
                <div
                  className={
                    STAGES.indexOf(activeApp.stage) >= i ? "reached" : ""
                  }
                  key={s}
                >
                  <span>
                    {STAGES.indexOf(activeApp.stage) > i ? (
                      <Check size={11} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <small>{STAGE_LABELS[s]}</small>
                </div>
              ))}
            </div>
            <div className="detail-tabs">
              {[
                ["profile", "资料与初筛"],
                ["interviews", "面试与评价"],
                ["history", "流程记录"],
              ].map(([id, label]) => (
                <button
                  className={detailTab === id ? "active" : ""}
                  key={id}
                  onClick={() => setDetailTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="drawer-body">
              {detailTab === "profile" && (
                <>
                  <div className="detail-info-grid">
                    <div>
                      <span>邮箱</span>
                      <strong>
                        {activeApp.snapshot.email || "未提供 / 已隐藏"}
                      </strong>
                    </div>
                    <div>
                      <span>手机</span>
                      <strong>
                        {activeApp.snapshot.phone || "未提供 / 已隐藏"}
                      </strong>
                    </div>
                    <div>
                      <span>院校 / 专业</span>
                      <strong>
                        {[activeApp.snapshot.school, activeApp.snapshot.major]
                          .filter(Boolean)
                          .join(" · ") || "待补充"}
                      </strong>
                    </div>
                    <div>
                      <span>毕业届别</span>
                      <strong>
                        {activeApp.snapshot.graduationYear
                          ? `${activeApp.snapshot.graduationYear} 届`
                          : "待核实"}
                      </strong>
                    </div>
                    <div>
                      <span>来源渠道</span>
                      <strong>{activeApp.source}</strong>
                    </div>
                    <div>
                      <span>可到岗时间</span>
                      <strong>
                        {activeApp.snapshot.availability || "待确认"}
                      </strong>
                    </div>
                  </div>
                  <div className="detail-section">
                    <h3>
                      01 <span>岗位条件核对</span>
                      <Badge tone="blue">规则核对</Badge>
                    </h3>
                    {activeApp.selection?.ruleReview ? (
                      activeApp.selection.ruleReview.evidence.map(
                        (item, index) => (
                          <div className="evidence-row" key={index}>
                            <span
                              className={`evidence-icon ${item.status === "matched" ? "yes" : ""}`}
                            >
                              {item.status === "matched" ? (
                                <Check size={13} />
                              ) : (
                                <Circle size={13} />
                              )}
                            </span>
                            <span>
                              <strong>{item.label}</strong>
                              <small>{item.quote}</small>
                            </span>
                            <Badge
                              tone={
                                item.status === "matched" ? "green" : "amber"
                              }
                            >
                              {item.status === "matched"
                                ? "符合"
                                : item.status === "missing"
                                  ? "未符合"
                                  : "待核实"}
                            </Badge>
                          </div>
                        ),
                      )
                    ) : (
                      <p className="detail-note">
                        尚未生成核对报告。到甄选中心配置岗位条件并执行核对，资料缺失会保留为待核实。
                      </p>
                    )}
                  </div>
                  <div className="detail-section">
                    <h3>
                      02 <span>AI 简历复筛</span>
                      <Badge tone="violet">规则模拟</Badge>
                    </h3>
                    <p className="detail-note">
                      {activeApp.selection?.resumeReview?.summary ||
                        "在甄选中心生成岗位匹配报告，逐项查看简历证据和待核实问题。"}
                    </p>
                    <p className="detail-note">
                      未调用大模型，模拟报告不代替 HR 的筛选结论。
                    </p>
                    {(isHR || user.role === "manager") && (
                      <button
                        className="button small primary"
                        onClick={() => openSelection(activeApp.id)}
                      >
                        打开甄选与测评
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                  <div className="detail-section">
                    <h3>
                      03 <span>HR 复核结论</span>
                    </h3>
                    <div className="review-note">
                      {activeApp.selection?.hrReview?.note ||
                        activeApp.screeningNote ||
                        "尚未填写筛选结论。推进到面试前，HR 需记录筛选依据。"}
                    </div>
                    {activeApp.selection?.hrReview && (
                      <small className="muted">
                        {person(state, activeApp.selection.hrReview.actorId)} ·{" "}
                        {dateTime(activeApp.selection.hrReview.createdAt)} ·{" "}
                        {
                          {
                            pass: "通过初筛",
                            hold: "待进一步核实",
                            reject: "不予推进",
                          }[activeApp.selection.hrReview.conclusion]
                        }
                      </small>
                    )}
                  </div>
                  <div className="detail-section">
                    <h3>
                      <span>简历文本快照</span>
                      {isHR && (
                        <button
                          className="text-button"
                          onClick={() =>
                            setModal({
                              kind: "editCandidate",
                              applicationId: activeApp.id,
                            })
                          }
                        >
                          编辑主档
                        </button>
                      )}
                    </h3>
                    <pre className="resume-text">
                      {activeApp.snapshot.resume || "暂无简历文本"}
                    </pre>
                    <p className="helper">
                      保留投递时的资料快照；主档更新不覆盖历史筛选依据。
                    </p>
                    {isHR && (
                      <button
                        className="text-button muted"
                        onClick={() =>
                          setModal({
                            kind: "anonymize",
                            applicationId: activeApp.id,
                            candidateId: activeApp.candidateId,
                          })
                        }
                      >
                        清理该候选人的合成资料
                      </button>
                    )}
                  </div>
                  {activeApp.offer.status !== "none" && (
                    <div className="detail-section">
                      <h3>
                        <span>录用与入职</span>
                      </h3>
                      <div className="detail-info-grid">
                        <div>
                          <span>Offer</span>
                          <strong>{offerStatus[activeApp.offer.status]}</strong>
                        </div>
                        <div>
                          <span>计划入职</span>
                          <strong>
                            {formatDate(activeApp.plannedJoinDate)}
                          </strong>
                        </div>
                        <div>
                          <span>协议台账</span>
                          <strong>
                            {activeApp.agreement.status === "signed"
                              ? "已登记签署"
                              : activeApp.agreement.status === "waived"
                                ? "不适用"
                                : "待办理"}
                          </strong>
                        </div>
                        <div>
                          <span>实际入职</span>
                          <strong>{formatDate(activeApp.joinedAt)}</strong>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              {detailTab === "interviews" && (
                <>
                  <div className="detail-section">
                    <h3>
                      <span>面试安排</span>
                      {isHR &&
                        activeApp.stage === "interview" &&
                        activeApp.status === "active" && (
                          <button
                            className="text-button"
                            onClick={() =>
                              setModal({
                                kind: "schedule",
                                applicationId: activeApp.id,
                              })
                            }
                          >
                            <Plus size={14} />
                            安排面试
                          </button>
                        )}
                    </h3>
                    {agenda(
                      state.interviews.filter(
                        (i) => i.applicationId === activeApp.id,
                      ),
                    )}
                  </div>
                  {state.interviews
                    .filter((i) => i.applicationId === activeApp.id)
                    .map((i) => (
                      <div className="detail-section" key={i.id}>
                        <h3>
                          <span>{i.round} · 结构化评价</span>
                        </h3>
                        {state.scorecards
                          .filter((c) => c.interviewId === i.id)
                          .map((c) => (
                            <div className="scorecard-view" key={c.id}>
                              <div>
                                <strong>{person(state, c.userId)}</strong>
                                <Badge
                                  tone={
                                    c.status === "submitted" ? "green" : "amber"
                                  }
                                >
                                  {c.status === "submitted" ? "已提交" : "草稿"}
                                </Badge>
                              </div>
                              <div className="rating-grid">
                                {Object.entries(c.ratings).map(
                                  ([key, value]) => (
                                    <span key={key}>
                                      {key}
                                      <strong>
                                        {value ?? "—"}
                                        <small>/5</small>
                                      </strong>
                                    </span>
                                  ),
                                )}
                              </div>
                              <p>{c.evidence || "暂无事实依据"}</p>
                              <small>
                                结论：{c.recommendation || "未填写"}
                              </small>
                              {c.userId === user.id &&
                                c.status === "submitted" && (
                                  <div className="assist-review">
                                    <div className="assist-review-heading">
                                      <strong>AI 辅助评价</strong>
                                      <Badge tone="violet">
                                        规则模拟 · 未调用大模型
                                      </Badge>
                                    </div>
                                    {c.assistReport ? (
                                      <>
                                        <p>{c.assistReport.summary}</p>
                                        {c.assistReport.evidence.map(
                                          (e, index) => (
                                            <div
                                              className="assist-evidence"
                                              key={index}
                                            >
                                              <strong>{e.label}</strong>
                                              <span>{e.quote}</span>
                                            </div>
                                          ),
                                        )}
                                        {c.assistReport.gaps.length > 0 && (
                                          <p className="muted">
                                            待补充：
                                            {c.assistReport.gaps.join("；")}
                                          </p>
                                        )}
                                        <small>
                                          {c.assistReport.disclaimer}
                                        </small>
                                      </>
                                    ) : (
                                      <p>
                                        你已完成独立评价。现在可以核对评分证据是否充分，报告不会改写你的分数。
                                      </p>
                                    )}
                                    <button
                                      className="button small"
                                      disabled={busy}
                                      onClick={() =>
                                        run("generate_interview_assist", {
                                          scorecardId: c.id,
                                        })
                                      }
                                    >
                                      {busy ? (
                                        <Spinner />
                                      ) : (
                                        <FileText size={14} />
                                      )}
                                      {c.assistReport
                                        ? "重新核对评价证据"
                                        : "生成辅助评价报告"}
                                    </button>
                                  </div>
                                )}
                              {isHR &&
                                c.status === "submitted" &&
                                activeApp.stage === "interview" && (
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setQuick({
                                        action: "returnScorecard",
                                        fields: { scorecardId: c.id },
                                        title: "退回面试评价",
                                        label: "退回原因",
                                      })
                                    }
                                  >
                                    退回本人补充
                                  </button>
                                )}
                            </div>
                          ))}
                        {i.interviewerIds.includes(user.id) &&
                          !state.scorecards.some(
                            (c) =>
                              c.interviewId === i.id &&
                              c.userId === user.id &&
                              c.status === "submitted",
                          ) && (
                            <p className="detail-note">
                              请先独立提交本人评价，再查看同次面试的其他评价。
                            </p>
                          )}
                      </div>
                    ))}
                  <div className="info-strip">
                    笔试、工作偏好问卷和文本面试可在甄选与测评中心体验。AI
                    报告当前使用固定规则模拟，需人工复核。
                  </div>
                  {activeApp.decisionNote && (
                    <div className="detail-section">
                      <h3>
                        <span>用人经理意见</span>
                        <Badge
                          tone={
                            activeApp.decision === "hire" ? "green" : "amber"
                          }
                        >
                          {activeApp.decision === "hire"
                            ? "建议录用"
                            : "不录用 / 待核实"}
                        </Badge>
                      </h3>
                      <p>{activeApp.decisionNote}</p>
                    </div>
                  )}
                </>
              )}
              {detailTab === "history" && (
                <div className="activity-list">
                  {state.events
                    .filter((e) => e.applicationId === activeApp.id)
                    .sort((a, b) => b.at.localeCompare(a.at))
                    .map((e) => (
                      <div key={e.id}>
                        <span className="activity-dot" />
                        <strong>{e.note || e.type}</strong>
                        <small>
                          {person(state, e.actorId)} · {dateTime(e.at)}
                        </small>
                      </div>
                    ))}
                </div>
              )}
              {activeApp.status === "closed" && (
                <div className="info-strip">
                  流程已结束：{activeApp.outcome}
                </div>
              )}
            </div>
            <div className="drawer-footer">
              <div>
                {isHR && (
                  <button
                    className="text-button"
                    onClick={() =>
                      setModal({
                        kind: "associate",
                        applicationId: activeApp.id,
                      })
                    }
                  >
                    投递其他职位
                  </button>
                )}
                {isHR && activeApp.status === "active" && (
                  <button
                    className="text-button muted"
                    onClick={() =>
                      setModal({ kind: "close", applicationId: activeApp.id })
                    }
                  >
                    结束投递
                  </button>
                )}
              </div>
              <div>
                {isHR &&
                  activeApp.status === "active" &&
                  ["new", "screening"].includes(activeApp.stage) && (
                    <button
                      className="button primary"
                      onClick={() =>
                        setModal({
                          kind: "advance",
                          applicationId: activeApp.id,
                        })
                      }
                    >
                      {activeApp.stage === "new" ? "开始筛选" : "推进面试"}
                      <ArrowRight size={15} />
                    </button>
                  )}
                {isHR &&
                  activeApp.status === "active" &&
                  activeApp.stage === "interview" && (
                    <>
                      <button
                        className="button"
                        onClick={() => {
                          setDetailTab("interviews");
                          setModal({
                            kind: "schedule",
                            applicationId: activeApp.id,
                          });
                        }}
                      >
                        安排面试
                      </button>
                      <button
                        className="button primary"
                        onClick={() =>
                          setModal({
                            kind: "offer",
                            applicationId: activeApp.id,
                          })
                        }
                      >
                        登记 Offer
                      </button>
                    </>
                  )}
                {user.role === "manager" &&
                  activeApp.status === "active" &&
                  activeApp.stage === "interview" && (
                    <button
                      className="button primary"
                      onClick={() =>
                        setModal({
                          kind: "decision",
                          applicationId: activeApp.id,
                        })
                      }
                    >
                      录用决策
                    </button>
                  )}
                {isHR &&
                  activeApp.status === "active" &&
                  activeApp.stage === "offer" && (
                    <button
                      className="button primary"
                      onClick={() =>
                        setModal({
                          kind: "offerResponse",
                          applicationId: activeApp.id,
                        })
                      }
                    >
                      登记答复
                    </button>
                  )}
                {isHR &&
                  activeApp.status === "active" &&
                  activeApp.stage === "onboarding" && (
                    <>
                      {activeJob.type === "campus" && (
                        <button
                          className="button"
                          onClick={() =>
                            setModal({
                              kind: "agreement",
                              applicationId: activeApp.id,
                            })
                          }
                        >
                          协议登记
                        </button>
                      )}
                      <button
                        className="button primary"
                        onClick={() =>
                          setModal({
                            kind: "join",
                            applicationId: activeApp.id,
                          })
                        }
                      >
                        确认入职
                      </button>
                    </>
                  )}
              </div>
            </div>
          </aside>
        </div>
      )}
      {modal && (
        <Modals
          modal={modal}
          state={state}
          user={user}
          onAction={action}
          onClose={() => setModal(null)}
        />
      )}
      {quick && (
        <ReasonModal
          config={quick}
          onClose={() => setQuick(null)}
          onSubmit={async (note) => {
            await action(quick.action, { ...quick.fields, note, reason: note });
            setQuick(null);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={17} />
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function InfoIcon() {
  return <AlertCircle size={15} />;
}
function ListChecksIcon() {
  return <FileText size={22} />;
}
function ReasonModal({
  config,
  onSubmit,
  onClose,
}: {
  config: { title: string; label: string };
  onSubmit: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={config.title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(note);
          } catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>{config.label}</span>
            <textarea
              required
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "保存中" : "确认保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
