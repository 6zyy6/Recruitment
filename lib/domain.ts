export type Role = "hr" | "manager" | "interviewer" | "admin";
export type Stage =
  | "new"
  | "screening"
  | "interview"
  | "offer"
  | "onboarding"
  | "joined";
export type RecruitmentType = "social" | "campus";
export interface User {
  id: string;
  name: string;
  role: Role;
  email: string;
}
export interface Job {
  id: string;
  title: string;
  department: string;
  location: string;
  type: RecruitmentType;
  batch: string;
  graduationYears: number[];
  headcount: number;
  ownerId: string;
  managerId: string;
  status: "draft" | "pending" | "open" | "paused" | "closed";
  description: string;
  skills: string[];
  dimensions: string[];
  createdAt: string;
}
export interface Candidate {
  id: string;
  name: string;
  email: string;
  phone: string;
  school: string;
  major: string;
  graduationYear: number | null;
  skills: string[];
  resume: string;
  availability: string;
  createdAt: string;
  restricted?: boolean;
}
export interface Application {
  id: string;
  candidateId: string;
  jobId: string;
  snapshot: Candidate;
  stage: Stage;
  status: "active" | "closed" | "joined";
  outcome: string;
  source: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  screeningNote: string;
  decision: "pending" | "hire" | "reject";
  decisionNote: string;
  offer: {
    status: "none" | "sent" | "accepted" | "rejected" | "expired" | "withdrawn";
    sentAt: string;
    deadline: string;
    answeredAt: string;
    reference: string;
  };
  agreement: { type: string; status: string; date: string; note: string };
  plannedJoinDate: string;
  joinedAt: string;
}
export interface Interview {
  id: string;
  applicationId: string;
  round: string;
  start: string;
  end: string;
  interviewerIds: string[];
  location: string;
  status: "scheduled" | "completed" | "no_show" | "cancelled";
  notified: boolean;
}
export interface Scorecard {
  id: string;
  interviewId: string;
  userId: string;
  ratings: Record<string, number | null>;
  evidence: string;
  recommendation: string;
  status: "draft" | "submitted";
  submittedAt: string;
}
export interface Activity {
  id: string;
  applicationId: string;
  actorId: string;
  at: string;
  type: string;
  from: string;
  to: string;
  note: string;
}
export interface ImportRow {
  index: number;
  raw: Record<string, string>;
  status: "ready" | "duplicate" | "success" | "error" | "skipped";
  error: string;
  candidateId: string;
  applicationId: string;
}
export interface ImportJob {
  id: string;
  jobId: string;
  createdAt: string;
  rows: ImportRow[];
}
export interface AppState {
  revision: number;
  seededAt: string;
  users: User[];
  jobs: Job[];
  candidates: Candidate[];
  applications: Application[];
  interviews: Interview[];
  scorecards: Scorecard[];
  events: Activity[];
  imports: ImportJob[];
}
export interface Snapshot {
  user: User;
  state: AppState;
}
export const STAGES: Stage[] = [
  "new",
  "screening",
  "interview",
  "offer",
  "onboarding",
  "joined",
];
export const STAGE_LABELS: Record<Stage, string> = {
  new: "新投递",
  screening: "筛选中",
  interview: "面试中",
  offer: "Offer",
  onboarding: "待入职",
  joined: "已入职",
};
export const ROLE_LABELS: Record<Role, string> = {
  hr: "招聘 HR",
  manager: "用人经理",
  interviewer: "面试官",
  admin: "系统管理员",
};
