/**
 * The Location Pursuit template vocabulary.
 *
 * One template serves every Location Pursuit — Mojave, Hawaiʻi and
 * `St. Louis — The Landing` included. There are no project-specific columns and
 * no per-project branches.
 */

export const requirementStates = [
  "unknown",
  "investigating",
  "in_progress",
  "evidenced",
  "blocked",
  "waived",
  "not_applicable",
] as const;
export type RequirementState = (typeof requirementStates)[number];

/** States that satisfy a gate. Everything else leaves it unmet. */
export const satisfyingRequirementStates: readonly RequirementState[] = [
  "evidenced",
  "waived",
  "not_applicable",
];

/** States that require an actor, a rationale and a timestamp. */
export const waiverRequirementStates: readonly RequirementState[] = ["waived", "not_applicable"];

export const pursuitPhases = [
  "identified",
  "qualifying",
  "diligence",
  "negotiation",
  "committed",
  "construction",
  "operating",
  "released",
] as const;
export type PursuitPhase = (typeof pursuitPhases)[number];

export function phaseIndex(phase: PursuitPhase): number {
  return pursuitPhases.indexOf(phase);
}

export const artifactModes = ["native", "linked", "snapshot"] as const;
export type ArtifactMode = (typeof artifactModes)[number];

export const artifactVisibilities = ["project", "private"] as const;
export type ArtifactVisibility = (typeof artifactVisibilities)[number];

export const evidenceTargetTypes = [
  "requirement",
  "decision",
  "risk",
  "blocker",
  "milestone",
  "report_statement",
] as const;
export type EvidenceTargetType = (typeof evidenceTargetTypes)[number];

export const locationPursuitTemplateKey = "location_pursuit";
export const locationPursuitTemplateVersion = 1;

export interface RequirementDefinitionSeed {
  key: string;
  name: string;
  description: string;
  requiredByPhase: PursuitPhase;
}

export interface DevelopmentAreaSeed {
  key: string;
  name: string;
  requirements: RequirementDefinitionSeed[];
}

/**
 * The eight approved development areas. Requirement wording describes what must
 * be established, never what is true of any particular site.
 */
export const locationPursuitDevelopmentAreas: DevelopmentAreaSeed[] = [
  {
    key: "site_and_land_control",
    name: "Site and land control",
    requirements: [
      { key: "site_identified", name: "Site identified and bounded", description: "The parcel or parcels under consideration are identified with a boundary.", requiredByPhase: "qualifying" },
      { key: "ownership_confirmed", name: "Ownership confirmed", description: "Current legal ownership is confirmed from a maintained record.", requiredByPhase: "diligence" },
      { key: "control_instrument", name: "Control instrument executed", description: "An option, lease, purchase agreement or equivalent gives Rangeway site control.", requiredByPhase: "committed" },
      { key: "title_review", name: "Title and encumbrance review complete", description: "Title, easements and encumbrances are reviewed for conflicts with the intended use.", requiredByPhase: "committed" },
    ],
  },
  {
    key: "utility_and_power",
    name: "Utility and power",
    requirements: [
      { key: "utility_identified", name: "Serving utility identified", description: "The utility with service territory over the site is identified.", requiredByPhase: "qualifying" },
      { key: "capacity_assessment", name: "Capacity assessment obtained", description: "Available capacity at or near the site is established with the utility.", requiredByPhase: "diligence" },
      { key: "interconnection_application", name: "Interconnection application submitted", description: "A service or interconnection application is on file.", requiredByPhase: "negotiation" },
      { key: "service_commitment", name: "Service commitment received", description: "The utility has committed to deliver the required service.", requiredByPhase: "committed" },
    ],
  },
  {
    key: "permitting_and_entitlement",
    name: "Permitting and entitlement",
    requirements: [
      { key: "jurisdiction_identified", name: "Permitting jurisdiction identified", description: "The authorities having jurisdiction over the site are identified.", requiredByPhase: "qualifying" },
      { key: "zoning_confirmed", name: "Zoning and permitted use confirmed", description: "Zoning permits the intended use, or the required path to it is identified.", requiredByPhase: "diligence" },
      { key: "entitlement_path", name: "Entitlement path established", description: "The sequence, timeline and approvals required are established.", requiredByPhase: "negotiation" },
      { key: "permits_issued", name: "Construction permits issued", description: "The permits required to begin construction are issued.", requiredByPhase: "construction" },
    ],
  },
  {
    key: "commercial_structure",
    name: "Commercial structure",
    requirements: [
      { key: "counterparty_identified", name: "Counterparty identified", description: "The landowner, host or development counterparty is identified.", requiredByPhase: "qualifying" },
      { key: "term_sheet", name: "Term sheet agreed", description: "Commercial terms are agreed in a term sheet or letter of intent.", requiredByPhase: "negotiation" },
      { key: "definitive_agreement", name: "Definitive agreement executed", description: "The binding commercial agreement is executed by all parties.", requiredByPhase: "committed" },
    ],
  },
  {
    key: "hospitality_program",
    name: "Hospitality program",
    requirements: [
      { key: "program_defined", name: "Hospitality program defined", description: "The destination experience intended at this location is defined.", requiredByPhase: "diligence" },
      { key: "operator_model", name: "Operating model established", description: "Who operates the hospitality program, and under what terms, is established.", requiredByPhase: "negotiation" },
      { key: "program_committed", name: "Program committed", description: "The program is committed and reflected in the design and agreements.", requiredByPhase: "committed" },
    ],
  },
  {
    key: "capital_and_economics",
    name: "Capital and economics",
    requirements: [
      { key: "cost_estimate", name: "Cost estimate prepared", description: "A cost estimate for the location is prepared from a maintained basis.", requiredByPhase: "diligence" },
      { key: "revenue_model", name: "Revenue model prepared", description: "Expected revenue and its assumptions are documented.", requiredByPhase: "diligence" },
      { key: "capital_committed", name: "Capital committed", description: "Funding for the location is committed and its source recorded.", requiredByPhase: "committed" },
    ],
  },
  {
    key: "design_and_construction",
    name: "Design and construction",
    requirements: [
      { key: "concept_design", name: "Concept design prepared", description: "A concept design fitting the site and format hypothesis exists.", requiredByPhase: "negotiation" },
      { key: "construction_documents", name: "Construction documents complete", description: "Documents sufficient to build from are complete.", requiredByPhase: "construction" },
      { key: "contractor_engaged", name: "Contractor engaged", description: "A contractor is engaged under an executed agreement.", requiredByPhase: "construction" },
    ],
  },
  {
    key: "partner_alignment",
    name: "Partner alignment",
    requirements: [
      { key: "stakeholders_mapped", name: "Stakeholders mapped", description: "The people and organizations whose support the location depends on are mapped.", requiredByPhase: "qualifying" },
      { key: "community_engagement", name: "Community engagement established", description: "An engagement approach for the surrounding community is established.", requiredByPhase: "diligence" },
      { key: "partners_aligned", name: "Partners aligned on commitments", description: "Each partner's commitments are recorded and agreed.", requiredByPhase: "committed" },
    ],
  },
];

export interface RequirementReadiness {
  total: number;
  satisfied: number;
  blocked: number;
  unknown: number;
}

export interface UnmetRequirement {
  requirementId: string;
  definitionKey: string;
  name: string;
  developmentAreaKey: string;
  state: RequirementState;
  requiredByPhase: PursuitPhase;
}

/**
 * A phase may only be entered once every requirement due at or before it is
 * satisfied. Callers receive the exact unmet set so a move is either refused or
 * reconciled with a recorded rationale — never silently allowed.
 */
export function unmetRequirementsForPhase(
  requirements: Array<{
    requirementId: string;
    definitionKey: string;
    name: string;
    developmentAreaKey: string;
    state: RequirementState;
    requiredByPhase: PursuitPhase;
  }>,
  targetPhase: PursuitPhase,
): UnmetRequirement[] {
  const target = phaseIndex(targetPhase);
  return requirements.filter(
    (requirement) =>
      phaseIndex(requirement.requiredByPhase) <= target &&
      !satisfyingRequirementStates.includes(requirement.state),
  );
}
