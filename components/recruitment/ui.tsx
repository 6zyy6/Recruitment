"use client";
import {
  useEffect,
  useRef,
  useId,
  isValidElement,
  cloneElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { X, SearchX, LoaderCircle } from "lucide-react";
import type { Snapshot } from "@/lib/domain";
export type Action = (
  action: string,
  fields?: Record<string, unknown>,
) => Promise<Snapshot>;
export type ModalState = {
  kind: string;
  applicationId?: string;
  interviewId?: string;
  jobId?: string;
  candidateId?: string;
  scorecardId?: string;
};
export function formatDate(
  value: string,
  options?: Intl.DateTimeFormatOptions,
) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        ...options,
      }).format(new Date(value))
    : "—";
}
export function dateTime(value: string) {
  return formatDate(value, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
export function inputDate(value: string) {
  if (!value) return "";
  const date = new Date(new Date(value).getTime() + 8 * 3600000);
  return date.toISOString().slice(0, 16);
}
export function toISO(value: string) {
  return value
    ? new Date(
        value.length === 10 ? value + "T00:00:00+08:00" : value + ":00+08:00",
      ).toISOString()
    : "";
}
export const jobStatus: Record<string, string> = {
  draft: "草稿",
  pending: "待审批",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};
export const offerStatus: Record<string, string> = {
  none: "待发送",
  sent: "待答复",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
  withdrawn: "已撤回",
};
export const interviewStatus: Record<string, string> = {
  scheduled: "已安排",
  completed: "已完成",
  no_show: "未出席",
  cancelled: "已取消",
};
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={"badge tone-" + tone}>{children}</span>;
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span className={"avatar " + (small ? "small" : "")}>{name.slice(-2)}</span>
  );
}
export function Empty({
  text,
  children,
}: {
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <SearchX size={29} />
      <p>{text}</p>
      {children}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={17} />;
}
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => {
      el?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal " + (wide ? "wide" : "")}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  required,
  children,
  help,
  span = false,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
  help?: string;
  span?: boolean;
}) {
  const id = useId();
  const control =
    isValidElement(children) &&
    typeof children.type === "string" &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div
      className={"field " + (span ? "full" : "")}
      role={control ? undefined : "group"}
      aria-labelledby={control ? undefined : id + "-label"}
    >
      <label id={id + "-label"} htmlFor={control ? id : undefined}>
        {label}
        {required && <b> *</b>}
      </label>
      {control
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id,
            "aria-required": required || undefined,
            "aria-describedby": help ? id + "-help" : undefined,
          })
        : children}
      {help && <small id={id + "-help"}>{help}</small>}
    </div>
  );
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="form-error" role="alert">
      {message}
    </div>
  ) : null;
}
export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }),
  );
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
