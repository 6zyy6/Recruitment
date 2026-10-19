import {
  STAGES,
  STAGE_LABELS,
  type AppState,
  type RecruitmentType,
  type Stage,
} from "./domain.ts";

export interface Filters {
  type?: "all" | RecruitmentType;
  batch?: string;
  jobId?: string;
  query?: string;
  from?: string;
  to?: string;
  cutoff?: string;
}

export function getMetrics(state: AppState, filters: Filters = {}) {
  const cutoff = filters.cutoff ? Date.parse(filters.cutoff) : Date.now();
  const from = filters.from ? Date.parse(filters.from) : -Infinity;
  const to = filters.to ? Date.parse(filters.to) : Infinity;
  const jobs = state.jobs.filter(
    (j) =>
      (!filters.type || filters.type === "all" || j.type === filters.type) &&
      (!filters.batch || j.batch === filters.batch) &&
      (!filters.jobId || j.id === filters.jobId),
  );
  const jobIds = new Set(jobs.map((j) => j.id));
  const query = (filters.query || "").trim().toLowerCase();
  const filteredApplications = state.applications.filter(
    (a) =>
      jobIds.has(a.jobId) &&
      a.outcome !== "录入错误" &&
      Date.parse(a.createdAt) >= from &&
      Date.parse(a.createdAt) < to &&
      Date.parse(a.createdAt) <= cutoff &&
      (!query ||
        [
          a.snapshot.name,
          a.snapshot.school,
          a.snapshot.major,
          ...a.snapshot.skills,
          state.jobs.find((j) => j.id === a.jobId)?.title || "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  const ids = new Set(filteredApplications.map((a) => a.id));
  const events = state.events.filter(
    (e) => ids.has(e.applicationId) && Date.parse(e.at) <= cutoff,
  );
  const reached = new Map(STAGES.map((stage) => [stage, new Set<string>()]));
  for (const a of filteredApplications) reached.get("new")!.add(a.id);
  for (const e of events) {
    if (STAGES.includes(e.to as Stage))
      reached.get(e.to as Stage)!.add(e.applicationId);
  }
  const funnel = STAGES.map((stage, index) => {
    const count = reached.get(stage)!.size;
    const previous = index
      ? reached.get(STAGES[index - 1])!.size
      : filteredApplications.length;
    return {
      stage,
      label: STAGE_LABELS[stage],
      count,
      conversion: previous ? count / previous : null,
    };
  });
  const stageAsOf = (applicationId: string) =>
    events
      .filter(
        (e) =>
          e.applicationId === applicationId && STAGES.includes(e.to as Stage),
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .at(-1)?.to || "new";
  const joined = filteredApplications.filter(
    (a) => stageAsOf(a.id) === "joined",
  ).length;
  const sources = [
    ...new Set(filteredApplications.map((a) => a.source || "未知")),
  ]
    .map((source) => {
      const apps = filteredApplications.filter(
        (a) => (a.source || "未知") === source,
      );
      return {
        source,
        count: apps.length,
        joined: apps.filter((a) => stageAsOf(a.id) === "joined").length,
      };
    })
    .sort((a, b) => b.count - a.count);
  const offerApps = filteredApplications.filter(
    (a) => a.offer.status !== "none" && Date.parse(a.offer.sentAt) <= cutoff,
  );
  const accepted = offerApps.filter(
    (a) =>
      a.offer.status === "accepted" && Date.parse(a.offer.answeredAt) <= cutoff,
  ).length;
  const rejected = offerApps.filter(
    (a) =>
      a.offer.status === "rejected" && Date.parse(a.offer.answeredAt) <= cutoff,
  ).length;
  const matureInterviews = state.interviews.filter(
    (i) =>
      ids.has(i.applicationId) &&
      i.status === "completed" &&
      Date.parse(i.end) + 86400000 <= cutoff,
  );
  let feedbackDue = 0;
  let feedbackTimely = 0;
  for (const i of matureInterviews) {
    for (const userId of i.interviewerIds) {
      feedbackDue++;
      const card = state.scorecards.find(
        (c) =>
          c.interviewId === i.id &&
          c.userId === userId &&
          c.status === "submitted",
      );
      if (card && Date.parse(card.submittedAt) <= Date.parse(i.end) + 86400000)
        feedbackTimely++;
    }
  }
  const responseHours = filteredApplications
    .map((a) => {
      const first = events
        .filter(
          (e) => e.applicationId === a.id && e.from === "new" && e.to !== "new",
        )
        .sort((x, y) => Date.parse(x.at) - Date.parse(y.at))[0];
      return first
        ? (Date.parse(first.at) - Date.parse(a.createdAt)) / 3600000
        : null;
    })
    .filter((v): v is number => v !== null && v >= 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(responseHours.length / 2);
  const median = responseHours.length
    ? responseHours.length % 2
      ? responseHours[middle]
      : (responseHours[middle - 1] + responseHours[middle]) / 2
    : null;
  return {
    filteredApplications,
    total: filteredApplications.length,
    people: new Set(filteredApplications.map((a) => a.candidateId)).size,
    active: filteredApplications.filter((a) => a.status === "active").length,
    joined,
    openJobs: jobs.filter((j) => j.status === "open").length,
    funnel,
    sources,
    offerSent: offerApps.length,
    offerAccepted: accepted,
    offerAcceptanceRate:
      accepted + rejected ? accepted / (accepted + rejected) : null,
    feedbackRate: feedbackDue ? feedbackTimely / feedbackDue : null,
    feedbackTimely,
    feedbackDue,
    firstResponseHours: median,
  };
}
