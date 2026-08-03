/**
 * Report templates and audience-role profiles.
 *
 * Profiles are roles, never people. There is no per-person disclosure logic
 * anywhere in this file, and a template cannot name an individual.
 */

export const reportTemplates = [
  "project_development_update",
  "location_pursuit_snapshot",
  "partner_briefing",
  "investor_portfolio_update",
  "diligence_evidence_summary",
  "milestone_decision_memo",
  "operating_report",
] as const;
export type ReportTemplateKey = (typeof reportTemplates)[number];

export const audienceRoles = [
  "internal_executive",
  "development_partner",
  "capital_investor",
  "landowner_host",
  "utility_infrastructure",
  "public_agency",
  "community_public",
] as const;
export type AudienceRole = (typeof audienceRoles)[number];

export const reportTemplateVersion = 1;
export const audienceProfileVersion = 1;

/** A section of report content, in the order it is rendered. */
export type ReportSection =
  | "summary"
  | "health"
  | "focus"
  | "work"
  | "milestones"
  | "decisions"
  | "risks"
  | "readiness"
  | "evidence"
  | "economics"
  | "portfolio";

export interface TemplateDefinition {
  key: ReportTemplateKey;
  title: string;
  sections: ReportSection[];
  /** Portfolio templates span the organization instead of one project. */
  scope: "project" | "portfolio";
}

export const templateDefinitions: Record<ReportTemplateKey, TemplateDefinition> = {
  project_development_update: {
    key: "project_development_update",
    title: "Project development update",
    scope: "project",
    sections: ["summary", "health", "focus", "work", "milestones", "decisions", "risks"],
  },
  location_pursuit_snapshot: {
    key: "location_pursuit_snapshot",
    title: "Location Pursuit snapshot",
    scope: "project",
    sections: ["summary", "health", "readiness", "milestones", "risks", "evidence"],
  },
  partner_briefing: {
    key: "partner_briefing",
    title: "Partner briefing",
    scope: "project",
    sections: ["summary", "focus", "milestones", "decisions"],
  },
  investor_portfolio_update: {
    key: "investor_portfolio_update",
    title: "Investor portfolio update",
    scope: "portfolio",
    sections: ["summary", "portfolio", "health", "economics", "risks"],
  },
  diligence_evidence_summary: {
    key: "diligence_evidence_summary",
    title: "Diligence and evidence summary",
    scope: "project",
    sections: ["summary", "readiness", "evidence"],
  },
  milestone_decision_memo: {
    key: "milestone_decision_memo",
    title: "Milestone and decision memo",
    scope: "project",
    sections: ["summary", "milestones", "decisions"],
  },
  operating_report: {
    key: "operating_report",
    title: "Operating report",
    scope: "portfolio",
    sections: ["summary", "portfolio", "health", "work", "risks"],
  },
};

export interface AudienceProfile {
  role: AudienceRole;
  label: string;
  /** Sections this audience may never receive, whatever the template asks for. */
  excludedSections: ReportSection[];
  /** Internal commentary is withheld from every external audience. */
  includesInternalCommentary: boolean;
  includesEconomics: boolean;
  includesRiskDetail: boolean;
}

export const audienceProfiles: Record<AudienceRole, AudienceProfile> = {
  internal_executive: {
    role: "internal_executive",
    label: "Internal executive",
    excludedSections: [],
    includesInternalCommentary: true,
    includesEconomics: true,
    includesRiskDetail: true,
  },
  development_partner: {
    role: "development_partner",
    label: "Development partner",
    excludedSections: ["economics"],
    includesInternalCommentary: false,
    includesEconomics: false,
    includesRiskDetail: true,
  },
  capital_investor: {
    role: "capital_investor",
    label: "Capital or investor",
    excludedSections: [],
    includesInternalCommentary: false,
    includesEconomics: true,
    includesRiskDetail: true,
  },
  landowner_host: {
    role: "landowner_host",
    label: "Landowner or host partner",
    excludedSections: ["economics", "portfolio"],
    includesInternalCommentary: false,
    includesEconomics: false,
    includesRiskDetail: false,
  },
  utility_infrastructure: {
    role: "utility_infrastructure",
    label: "Utility or infrastructure partner",
    excludedSections: ["economics", "portfolio"],
    includesInternalCommentary: false,
    includesEconomics: false,
    includesRiskDetail: false,
  },
  public_agency: {
    role: "public_agency",
    label: "Public agency or permitting authority",
    excludedSections: ["economics", "portfolio", "decisions"],
    includesInternalCommentary: false,
    includesEconomics: false,
    includesRiskDetail: false,
  },
  community_public: {
    role: "community_public",
    label: "Community or public audience",
    excludedSections: ["economics", "portfolio", "decisions", "risks", "evidence"],
    includesInternalCommentary: false,
    includesEconomics: false,
    includesRiskDetail: false,
  },
};

export interface SectionDecision {
  section: ReportSection;
  included: boolean;
  reason: string;
}

/**
 * Resolves which sections this template and audience produce, recording why each
 * section was included or left out. The reasons are frozen into the snapshot so
 * an omission is always explainable after the fact.
 */
export function resolveSections(
  template: TemplateDefinition,
  profile: AudienceProfile,
): SectionDecision[] {
  return template.sections.map((section) => {
    if (profile.excludedSections.includes(section)) {
      return { section, included: false, reason: `excluded_for_${profile.role}` };
    }
    if (section === "economics" && !profile.includesEconomics) {
      return { section, included: false, reason: "economics_withheld_from_audience" };
    }
    if (section === "risks" && !profile.includesRiskDetail) {
      return { section, included: false, reason: "risk_detail_withheld_from_audience" };
    }
    return { section, included: true, reason: "included_by_template" };
  });
}

export const reportStates = ["draft", "approved", "rendered", "delivered", "failed"] as const;
export type ReportState = (typeof reportStates)[number];
