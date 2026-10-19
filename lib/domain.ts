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
export type EducationLevel =
  | "any"
  | "college"
  | "bachelor"
  | "master"
  | "doctor";
export interface ScreeningPolicy {
  minimumEducation: EducationLevel;
  requiredSkills: string[];
  graduationYears: number[];
  updatedAt: string;
}
export interface SelectionEvidence {
  label: string;
  status: "matched" | "missing" | "unknown" | "info";
  quote: string;
  points?: number;
  maxPoints?: number;
}
export interface SelectionReport {
  createdAt: string;
  kind:
    | "rule"
    | "resume"
    | "written"
    | "preference"
    | "ai_interview"
    | "interview_assist";
  mode: "rule_demo";
  ruleVersion?: string;
  title: string;
  summary: string;
  score: number | null;
  maxScore: number | null;
  evidence: SelectionEvidence[];
  gaps: string[];
  disclaimer: string;
  policy?: ScreeningPolicy;
}
export type AssessmentKind = "written" | "preference" | "ai_interview";
export interface AssessmentQuestion {
  id: string;
  prompt: string;
  type: "single_choice" | "text" | "likert";
  options?: { value: string; label: string }[];
  required: boolean;
  minLength?: number;
  maxLength?: number;
}
export interface Assessment {
  id: string;
  kind: AssessmentKind;
  title: string;
  status: "assigned" | "submitted";
  assignedAt: string;
  assignedBy: string;
  questions: AssessmentQuestion[];
  answers: Record<string, string>;
  submittedAt: string;
  report?: SelectionReport;
}
export interface ApplicationSelection {
  ruleReview?: SelectionReport;
  resumeReview?: SelectionReport;
  hrReview?: {
    createdAt: string;
    actorId: string;
    conclusion: "pass" | "hold" | "reject";
    note: string;
  };
  assessments: Assessment[];
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
  screeningPolicy?: ScreeningPolicy;
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
  education?: string;
  skills: string[];
  resume: string;
  availability: string;
  createdAt: string;
  restricted?: boolean;
  review?: CandidateReviewSummary;
}
export type CandidateReviewDelivery = "preview" | "pending" | "sent" | "failed";
export interface CandidateReviewSummary {
  reviewId: string;
  applicationId: string;
  status: "pending" | "submitted" | "revoked" | "expired";
  version: number;
  createdAt: string;
  expiresAt: string;
  submittedAt: string;
  revokedAt: string;
  delivery: CandidateReviewDelivery;
}
export interface CandidateReviewFields {
  name: string;
  email: string;
  phone: string;
  school: string;
  education: string;
  major: string;
  graduationYear: number | null;
  skills: string[];
  availability: string;
}
// Stored only in the server state; never included in an authenticated projection.
export interface CandidateReview extends CandidateReviewSummary {
  id: string;
  candidateId: string;
  createdBy: string;
  tokenHash: string;
  fields: CandidateReviewFields;
  candidateAtIssue: CandidateReviewFields;
  submittedFields?: CandidateReviewFields;
  deliveryReason: string;
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
  selection?: ApplicationSelection;
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
  assistReport?: SelectionReport;
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
  reviews?: CandidateReview[];
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
