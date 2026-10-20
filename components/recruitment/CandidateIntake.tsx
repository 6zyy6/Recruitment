"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  Upload,
  FileText,
  CheckCircle2,
  Mail,
  Copy,
  ExternalLink,
  Info,
  AlertCircle,
  RotateCcw,
  ShieldCheck,
  ArrowRight,
  X,
} from "lucide-react";
import {
  DeliveryStatus,
  mailDeliveryLabel,
  type MailDelivery,
} from "./CandidateReviewInvite";
import type { AppState, Snapshot, User } from "@/lib/domain";
import { extractResumeFile, MAX_RESUME_BYTES } from "@/lib/resume-file";
import { parseResumeText, type ResumeFields } from "@/lib/resume-parser";
import {
  type Action,
  Badge,
  ErrorMessage,
  Field,
  Modal,
  Spinner,
  dateTime,
} from "./ui";

type Props = {
  state: AppState;
  user: User;
  onAction: Action;
  onClose: () => void;
  defaultJobId?: string;
};
type Parsed = ReturnType<typeof parseResumeText>;
type Invitation = {
  reviewUrl: string;
  review: {
    id: string;
    applicationId: string;
    status: string;
    expiresAt: string;
    delivery: string;
  };
  mailPreview: {
    to: string;
    subject: string;
    text: string;
    status: string;
    reason: string;
  };
  snapshot: Snapshot;
  mailDelivery?: MailDelivery;
};
const blankFields: ResumeFields = {
  name: "",
  email: "",
  phone: "",
  school: "",
  major: "",
  education: "unknown",
  graduationYear: "",
  skills: "",
  resume: "",
  availability: "",
};
const educationOptions = [
  ["unknown", "待核实"],
  ["college", "大专"],
  ["bachelor", "本科"],
  ["master", "硕士"],
  ["doctor", "博士"],
];
const keys = Object.keys(blankFields) as Array<keyof ResumeFields>;
const splitSkills = (value: string) =>
  value
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function CandidateIntake({
  state,
  user,
  onAction,
  onClose,
  defaultJobId,
}: Props) {
  const [fields, setFields] = useState<ResumeFields>({ ...blankFields });
  const [jobId, setJobId] = useState(
    state.jobs.find((j) => j.id === defaultJobId && j.status === "open")?.id ||
      state.jobs.find((j) => j.status === "open")?.id ||
      "",
  );
  const [source, setSource] = useState("简历上传");
  const [invite, setInvite] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState("");
  const [parseNote, setParseNote] = useState("");
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [delivery, setDelivery] = useState<MailDelivery | null>(null);
  const [configLink, setConfigLink] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const uncertain =
    delivery?.status === "unknown" || delivery?.status === "sending";
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const changed = useRef(new Set<keyof ResumeFields>());
  const latestSnapshot = useRef<Snapshot>({ user, state });
  const createdRef = useRef("");
  const savingRef = useRef(false);
  const parsingRef = useRef(false);
  const job = state.jobs.find((j) => j.id === jobId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.revision > latestSnapshot.current.state.revision)
      latestSnapshot.current = { user, state };
  }, [state, user]);

  function changeField(key: keyof ResumeFields, value: string) {
    changed.current.add(key);
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  function close() {
    generation.current++;
    mounted.current = false;
    onClose();
  }
  async function readFile(file: File) {
    if (savingRef.current || createdRef.current) return;
    const sequence = ++generation.current;
    parsingRef.current = true;
    setParsing(true);
    setParseError("");
    setParseNote("");
    setParsed(null);
    setReplaceConfirm(false);
    setFileName(file.name);
    try {
      if (file.size > MAX_RESUME_BYTES)
        throw new Error("简历超过 3 MiB，请压缩文件或直接粘贴简历文本。");
      const { text } = await extractResumeFile(file);
      if (!mounted.current || generation.current !== sequence) return;
      const result = parseResumeText(text, job?.skills || []);
      setParsed(result);
      setFields((previous) => {
        const next = { ...previous };
        for (const key of keys) {
          const value = result.fields[key];
          const empty =
            !next[key].trim() ||
            (key === "education" && next[key] === "unknown");
          if (value && empty && !changed.current.has(key)) {
            next[key] = value;
          }
        }
        return next;
      });
      setParseNote(
        "识别完成：仅补充空缺且未编辑的字段，已填写内容保留。可直接建档并邀请候选人核对，也可先修改识别内容。",
      );
    } catch (cause) {
      if (mounted.current && generation.current === sequence)
        setParseError(
          cause instanceof Error
            ? cause.message
            : "简历识别失败，请手动填写或更换文件。",
        );
    } finally {
      if (mounted.current && generation.current === sequence) {
        setParsing(false);
        parsingRef.current = false;
      }
    }
  }
  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
    event.target.value = "";
  }
  function replaceFields() {
    if (!parsed) return;
    const next = { ...blankFields };
    for (const key of keys) next[key] = parsed.fields[key] || blankFields[key];
    changed.current.clear();
    setFields(next);
    setReplaceConfirm(false);
    setParseNote(
      "已使用当前简历的识别结果替换资料；未识别项已留空，请人工补充核实。",
    );
  }
  async function requestInvitation(applicationId: string) {
    let responseStatus = 0;
    let deliverySet = false;
    if (mounted.current) {
      setConfigLink("");
      setSignInUrl("");
      setInvitation(null);
      setDelivery({
        status: "sending",
        reason: "正在提交核对邮件发送请求，请等待服务端返回结果。",
      });
    }
    try {
      const response = await fetch("/api/candidate-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "createCandidateReview",
          applicationId,
          expectedRevision: latestSnapshot.current.state.revision,
          sendEmail: true,
        }),
      });
      responseStatus = response.status;
      const data = (await response.json()) as Partial<Invitation> & {
        message?: string;
        connectUrl?: string;
        signInUrl?: string;
      };
      if (data.snapshot) latestSnapshot.current = data.snapshot;
      if (mounted.current) {
        if (data.mailDelivery) {
          setDelivery(data.mailDelivery);
          deliverySet = true;
        }
        if (data.signInUrl) setSignInUrl(data.signInUrl);
        if (data.connectUrl || response.status === 503)
          setConfigLink(data.connectUrl || "/mail-connect");
        if (data.reviewUrl && data.mailPreview && data.review && data.snapshot)
          setInvitation(data as Invitation);
      }
      if (!response.ok)
        throw new Error(
          data.message || "发送请求未完成，请核实 Gmail 已发送记录。",
        );
      if (mounted.current && !data.mailDelivery)
        setDelivery({
          status: "preview",
          reason: "服务端未返回 Gmail 发送确认，仅显示已生成的预览。",
        });
    } catch (cause) {
      if (mounted.current && !deliverySet)
        setDelivery({
          status: [400, 401, 403, 404, 422, 503].includes(responseStatus)
            ? "failed"
            : "unknown",
          reason: responseStatus
            ? cause instanceof Error
              ? cause.message
              : "发送请求未完成。"
            : "未取得服务端发送结果，邮件可能已被 Gmail 接受。请先核实已发送记录。",
        });
      throw cause;
    }
  }
  async function retryInvitation() {
    if (
      !createdRef.current ||
      createdRef.current === "saved" ||
      savingRef.current ||
      uncertain
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await requestInvitation(createdRef.current);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "发送请求未完成，请先核实当前状态。",
        );
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || parsingRef.current || createdRef.current) return;
    if (!fields.email.trim() && !fields.phone.trim()) {
      setError("邮箱与手机号码至少填写一种，请补充可用联系方式。");
      return;
    }
    if (invite && !fields.email.trim()) {
      setError(
        "发送候选人核对邮件需要邮箱；请补充邮箱，或选择“仅保存，稍后邀请”。",
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const before = new Set(state.applications.map((a) => a.id));
      const snapshot = await onAction("createCandidate", {
        ...fields,
        name: fields.name.trim(),
        email: fields.email.trim(),
        phone: fields.phone.trim(),
        jobId,
        source,
        graduationYear: fields.graduationYear
          ? Number(fields.graduationYear)
          : null,
        skills: splitSkills(fields.skills),
      });
      latestSnapshot.current = snapshot;
      const created = snapshot.state.applications.find(
        (a) =>
          !before.has(a.id) &&
          a.jobId === jobId &&
          a.snapshot.email.toLowerCase() ===
            fields.email.trim().toLowerCase() &&
          a.snapshot.phone === fields.phone.trim(),
      );
      if (!created) {
        createdRef.current = "saved";
        if (mounted.current) setCreatedId("saved");
        throw new Error(
          "档案已保存，但未能定位新投递。请关闭弹窗，在候选人详情中生成核对邀请，避免重复建档。",
        );
      }
      createdRef.current = created.id;
      if (!mounted.current) return;
      setCreatedId(created.id);
      if (invite) await requestInvitation(created.id);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请检查后重试。",
        );
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function gmailUrl() {
    if (!invitation) return "";
    return (
      "https://mail.google.com/mail/?view=cm&fs=1&to=" +
      encodeURIComponent(invitation.mailPreview.to) +
      "&su=" +
      encodeURIComponent(invitation.mailPreview.subject) +
      "&body=" +
      encodeURIComponent(invitation.mailPreview.text)
    );
  }
  async function copyLink() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.reviewUrl);
      setCopied(true);
    } catch {
      setError("当前浏览器无法自动复制，请在下方链接框中选中并手动复制。");
    }
  }
  function fieldHelp(key: keyof ResumeFields, fallback?: string) {
    const evidence = parsed?.evidence[key];
    return evidence
      ? fields[key] !== parsed?.fields[key]
        ? `当前填写值已保留或被修改；本份简历线索供对照：${evidence}`
        : `识别线索（请核对）：${evidence}`
      : parsed && (!fields[key] || fields[key] === "unknown")
        ? "未可靠识别，请人工补充或保留待核实。"
        : fallback;
  }
  if (user.role !== "hr")
    return (
      <Modal title="添加候选人" onClose={close}>
        <div className="modal-body">
          <ErrorMessage message="添加候选人需要招聘 HR 权限。" />
        </div>
        <div className="modal-footer">
          <button className="button" onClick={close}>
            关闭
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={createdId ? "档案与候选人核对" : "上传简历，建立候选人档案"}
      subtitle={
        createdId
          ? "创建与发送分别保存；发送结果不确定时，请先核实 Gmail 已发送记录。"
          : "上传后自动填入资料，建档并邀请候选人自行核对。"
      }
      onClose={close}
      wide
    >
      <div className="intake">
        {createdId ? (
          <>
            <div className="modal-body intake-success-body">
              <div className="intake-created">
                <CheckCircle2 size={27} />
                <div>
                  <h3>候选人档案与投递已创建</h3>
                  <p>
                    {fields.name} · {job?.title}
                  </p>
                </div>
                <Badge tone="green">已保存</Badge>
              </div>
              {delivery && <DeliveryStatus delivery={delivery} />}
              {uncertain && (
                <div className="mail-delivery-actions">
                  <a
                    className="button"
                    href="https://mail.google.com/mail/#sent"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink size={15} />
                    核实 Gmail 已发送
                  </a>
                  <span>
                    请关闭后刷新候选人详情核实发送状态；需要重新发送时，先明确撤销旧邀请。
                  </span>
                </div>
              )}
              {invitation ? (
                <>
                  <div className="intake-invite-state">
                    <Mail size={18} />
                    <div>
                      <strong>
                        {delivery
                          ? mailDeliveryLabel(delivery)
                          : "核对邮件内容已生成"}
                      </strong>
                      <p>核对链接仅对应本次投递，7 天有效，请勿转发。</p>
                    </div>
                  </div>
                  <div className="intake-mail">
                    <div>
                      <span>收件人</span>
                      <strong>{invitation.mailPreview.to}</strong>
                    </div>
                    <div>
                      <span>主题</span>
                      <strong>{invitation.mailPreview.subject}</strong>
                    </div>
                    <div className="intake-mail-text">
                      <span>邮件正文预览</span>
                      <pre>{invitation.mailPreview.text}</pre>
                    </div>
                  </div>
                  <Field
                    label="候选人核对链接"
                    help="核对链接仅对应本次投递，7 天有效，请勿转发。"
                  >
                    <input
                      readOnly
                      value={invitation.reviewUrl}
                      onFocus={(e) => e.target.select()}
                    />
                  </Field>
                  <p className="intake-gmail-note">
                    核对链接有效至 {dateTime(invitation.review.expiresAt)}
                    ；重新生成邀请会使旧链接失效。
                  </p>
                  <div className="intake-link-actions">
                    <button type="button" className="button" onClick={copyLink}>
                      <Copy size={15} />
                      {copied ? "已复制核对链接" : "复制核对链接"}
                    </button>
                    <a
                      className="button primary"
                      href={invitation.reviewUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={15} />
                      打开候选人演示页
                    </a>
                    {delivery &&
                      ["failed", "preview"].includes(delivery.status) && (
                        <a
                          className="button"
                          href={gmailUrl()}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          <Mail size={15} />
                          备用：在 Gmail 打开草稿
                        </a>
                      )}
                  </div>
                  <p className="intake-gmail-note">
                    发送状态以上方记录为准；如需核实，请查看 Gmail
                    已发送邮件。核对链接仅用于本次投递，请勿转发或填写真实个人资料。
                  </p>
                </>
              ) : (
                <div className="intake-invite-state">
                  <Info size={19} />
                  <div>
                    <strong>
                      {invite
                        ? "档案已保存，发送请求尚未完成"
                        : "已仅保存档案，尚未邀请核对"}
                    </strong>
                    <p>
                      {invite
                        ? uncertain
                          ? "发送结果待核实，请先到 Gmail 检查已发送记录。"
                          : "确认未发送后可重新点击发送；此操作不会重复创建候选人。"
                        : "稍后可在候选人详情中生成核对邀请。"}
                    </p>
                  </div>
                </div>
              )}
              <ErrorMessage message={error} />
              {(configLink || signInUrl) && (
                <div className="mail-delivery-actions">
                  {configLink && (
                    <a
                      className="button"
                      href={configLink}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <Mail size={15} />
                      配置发件 Gmail
                    </a>
                  )}
                  {signInUrl && (
                    <a
                      className="button primary"
                      href={signInUrl}
                      target="_top"
                    >
                      以站点所有者身份登录
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              {invite &&
                createdId !== "saved" &&
                !uncertain &&
                (!delivery ||
                  delivery.status === "failed" ||
                  delivery.status === "preview") && (
                  <button
                    className="button primary"
                    disabled={saving}
                    onClick={retryInvitation}
                  >
                    {saving ? <Spinner /> : <RotateCcw size={15} />}
                    确认重新发送核对邮件
                  </button>
                )}
              <button
                className={invitation || !invite ? "button primary" : "button"}
                onClick={close}
              >
                {saving ? "关闭（档案已保存）" : "完成"}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="modal-body">
              <div className="intake-steps">
                <span className="active">
                  <b>1</b>上传与识别
                </span>
                <ArrowRight size={13} />
                <span>
                  <b>2</b>自动填入资料
                </span>
                <ArrowRight size={13} />
                <span>
                  <b>3</b>创建与邀请
                </span>
              </div>
              <div
                className={
                  "intake-upload " +
                  (dragging ? "dragging " : "") +
                  (parsing ? "parsing" : "")
                }
                role="button"
                tabIndex={saving ? -1 : 0}
                aria-label="上传 PDF、DOCX 或 TXT 简历，最大 3 MiB"
                aria-busy={parsing}
                aria-disabled={saving}
                onClick={() => {
                  if (!saving) fileInput.current?.click();
                }}
                onKeyDown={(e) => {
                  if (!saving && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    fileInput.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!saving) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (saving) return;
                  const file = e.dataTransfer.files[0];
                  if (file) void readFile(file);
                }}
              >
                {parsing ? (
                  <Spinner />
                ) : (
                  <span className="intake-upload-icon">
                    <Upload size={24} />
                  </span>
                )}
                <strong>
                  {parsing
                    ? "正在本地提取和识别简历…"
                    : fileName
                      ? fileName
                      : "点击上传，或将一份简历拖到这里"}
                </strong>
                <span>
                  {parsing
                    ? "可以继续填写字段；识别结果不会覆盖已编辑内容。"
                    : "PDF / DOCX / TXT · 最大 3 MiB · 仅本地提取，不保存原文件"}
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                  hidden
                  onChange={chooseFile}
                  disabled={saving}
                />
              </div>
              {parseError && (
                <div className="intake-parse-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{parseError} 也可以直接填写下方字段。</span>
                  <button
                    type="button"
                    aria-label="关闭解析错误"
                    onClick={() => setParseError("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {parsed && (
                <div className="intake-recognition">
                  <div className="intake-recognition-title">
                    <ShieldCheck size={17} />
                    <strong>识别完成，待候选人核对</strong>
                    <Badge tone="blue">本地规则提取</Badge>
                  </div>
                  <p>{parseNote}</p>
                  {parsed.warnings.length > 0 && (
                    <ul>
                      {parsed.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setReplaceConfirm(!replaceConfirm)}
                    disabled={saving}
                  >
                    使用本份简历替换当前资料
                  </button>
                  {replaceConfirm && (
                    <div className="intake-replace-confirm">
                      <p>
                        替换会清空当前已编辑内容，并使用本份简历的识别结果。未可靠识别的字段将留空。
                      </p>
                      <div>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setReplaceConfirm(false)}
                        >
                          保留当前内容
                        </button>
                        <button
                          type="button"
                          className="button danger-outline"
                          onClick={replaceFields}
                        >
                          确认替换并重新填写
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="intake-form-title">
                <FileText size={17} />
                <h3>候选人资料</h3>
                <span>可直接修改，未知字段交由人工核实</span>
              </div>
              <div className="form-grid">
                <Field label="投递职位" required span>
                  <select
                    required
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                    disabled={saving}
                  >
                    <option value="" disabled>
                      选择正在招聘的职位
                    </option>
                    {state.jobs
                      .filter((j) => j.status === "open")
                      .map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.title} · {j.type === "campus" ? "校招" : "社招"}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="姓名" required help={fieldHelp("name")}>
                  <input
                    required
                    maxLength={30}
                    value={fields.name}
                    onChange={(e) => changeField("name", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="来源渠道">
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    disabled={saving}
                  >
                    {[
                      "简历上传",
                      "招聘网站",
                      "内部推荐",
                      "主动寻访",
                      "校招官网",
                      "校园宣讲",
                      "人才库",
                      "其他",
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={invite ? "核对邀请邮箱" : "邮箱（与手机至少填写一项）"}
                  required={invite}
                  help={fieldHelp(
                    "email",
                    "核对邀请需要候选人的邮箱地址，可由 HR 修正。 ",
                  )}
                >
                  <input
                    type="email"
                    required={invite}
                    value={fields.email}
                    onChange={(e) => changeField("email", e.target.value)}
                    placeholder="name@example.com"
                    disabled={saving}
                  />
                </Field>
                <Field label="手机号码" help={fieldHelp("phone")}>
                  <input
                    type="tel"
                    minLength={7}
                    maxLength={20}
                    value={fields.phone}
                    onChange={(e) => changeField("phone", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="毕业院校" help={fieldHelp("school")}>
                  <input
                    value={fields.school}
                    onChange={(e) => changeField("school", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="专业" help={fieldHelp("major")}>
                  <input
                    value={fields.major}
                    onChange={(e) => changeField("major", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="学历" help={fieldHelp("education")}>
                  <select
                    value={fields.education}
                    onChange={(e) => changeField("education", e.target.value)}
                    disabled={saving}
                  >
                    {educationOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="毕业年份"
                  help={fieldHelp("graduationYear", "未知可留空，由 HR 核实。")}
                >
                  <input
                    type="number"
                    min="1960"
                    max="2100"
                    value={fields.graduationYear}
                    onChange={(e) =>
                      changeField("graduationYear", e.target.value)
                    }
                    disabled={saving}
                  />
                </Field>
                <Field label="可到岗时间" span help={fieldHelp("availability")}>
                  <input
                    value={fields.availability}
                    onChange={(e) =>
                      changeField("availability", e.target.value)
                    }
                    disabled={saving}
                    placeholder="如：两周内"
                  />
                </Field>
                <Field
                  label="专业技能"
                  span
                  help={fieldHelp(
                    "skills",
                    "多项技能用逗号分隔，识别线索不等于已核实能力。",
                  )}
                >
                  <input
                    value={fields.skills}
                    onChange={(e) => changeField("skills", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field
                  label="简历文本"
                  span
                  help="从文件提取的内容可修改；PDF 扫描件须先转成可复制文本，或在此直接填写。"
                >
                  <textarea
                    rows={6}
                    maxLength={20000}
                    value={fields.resume}
                    onChange={(e) => changeField("resume", e.target.value)}
                    disabled={saving}
                  />
                </Field>
              </div>
              <div className="intake-invite-option">
                <label>
                  <input
                    type="checkbox"
                    checked={invite}
                    onChange={(e) => setInvite(e.target.checked)}
                    disabled={saving}
                  />
                  <span>
                    <strong>建档后发送资料核对邮件</strong>
                    <small>
                      {invite
                        ? "点击下方创建并发送按钮后，将通过已连接 Gmail 发送到上方邮箱。发送前请核实收件地址。"
                        : "仅保存，稍后邀请。不会为本次操作生成核对链接。"}
                    </small>
                  </span>
                </label>
              </div>
              <div className="intake-privacy">
                <ShieldCheck size={14} />
                <span>
                  仅使用合成简历体验。原文件不上传；确认保存后，表单中的简历文本和资料会存入演示系统。
                </span>
              </div>
              {!jobId && (
                <ErrorMessage message="当前没有可接收投递的职位，请先创建并发布职位。" />
              )}
              <ErrorMessage message={error} />
              {(configLink || signInUrl) && (
                <div className="mail-delivery-actions">
                  {configLink && (
                    <a
                      className="button"
                      href={configLink}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <Mail size={15} />
                      配置发件 Gmail
                    </a>
                  )}
                  {signInUrl && (
                    <a
                      className="button primary"
                      href={signInUrl}
                      target="_top"
                    >
                      以站点所有者身份登录
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="button" onClick={close}>
                取消
              </button>
              <button
                className="button primary"
                disabled={saving || parsing || !jobId}
              >
                {saving ? (
                  <Spinner />
                ) : invite ? (
                  <Mail size={15} />
                ) : (
                  <CheckCircle2 size={15} />
                )}{" "}
                {saving
                  ? "正在保存…"
                  : invite
                    ? "创建档案并发送核对邮件"
                    : "仅保存，稍后邀请"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
