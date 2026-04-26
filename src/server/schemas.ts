import { z } from "zod";

const optionalText = z.string().trim().max(5000).optional().default("");
const shortText = z.string().trim().max(255).optional().default("");

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(255),
  company: shortText,
  role: shortText,
  email: z.string().trim().email().or(z.literal("")).optional().default(""),
  phone: shortText,
  location: shortText,
  stage: z.enum(["New", "Researching", "Intro Made", "Active Conversation", "Diligence", "Partnered", "On Hold", "Closed"]).optional().default("New"),
  category: z
    .enum(["Hotel Operator", "Real Estate", "Landowner", "Utility", "Energy Partner", "Charging Partner", "Investor", "Public Agency", "Vendor", "Team", "Community", "Other"])
    .optional()
    .default("Real Estate"),
  notes: optionalText
});

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  format: z.enum(["Trailhead", "Waystation", "Basecamp", "Summit", "Other"]).optional().default("Waystation"),
  status: z
    .enum(["Scouting", "Outreach", "Discovery", "Site Control", "Utility Study", "Design", "Permitting", "Capital Stack", "Pre-Construction", "Construction", "Live", "Paused", "Closed"])
    .optional()
    .default("Scouting"),
  priority: z.enum(["Low", "Medium", "High", "Critical"]).optional().default("Medium"),
  location: shortText,
  owner: shortText,
  targetDate: z.string().trim().max(40).optional().default(""),
  estimatedValue: z.number().int().nonnegative().nullable().optional().default(null),
  corridor: shortText,
  siteFit: z.enum(["Unknown", "Quiet Corridor", "Regional Route", "High-Traffic Run", "Destination Stay"]).optional().default("Unknown"),
  landStatus: z.enum(["Unknown", "Identified", "Owner Contacted", "LOI", "Under Control", "Not Viable"]).optional().default("Unknown"),
  utilityStatus: z.enum(["Unknown", "Needs Review", "Interconnect Requested", "Utility Study", "Upgrade Required", "Ready", "Off-Grid Path"]).optional().default("Unknown"),
  powerStrategy: z.enum(["Grid", "Grid + Storage", "Solar + Storage", "Off-Grid", "Partner-Funded Infrastructure", "Unknown"]).optional().default("Unknown"),
  hospitalityScope: z.enum(["Restrooms Nearby", "Staffed Cafe", "Clubhouse + Lookouts", "Partner Amenity", "Unknown"]).optional().default("Unknown"),
  nextMilestone: shortText,
  riskLevel: z.enum(["Low", "Medium", "High", "Blocked"]).optional().default("Medium"),
  notes: optionalText
});

export const linkProjectSchema = z.object({
  projectId: z.string().min(1),
  relationship: z.string().trim().min(1).max(100).optional().default("Stakeholder"),
  notes: optionalText
});

export const linkContactSchema = z.object({
  contactId: z.string().min(1),
  relationship: z.string().trim().min(1).max(100).optional().default("Stakeholder"),
  notes: optionalText
});

export const taskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  status: z.enum(["Open", "In Progress", "Waiting", "Done"]).optional().default("Open"),
  priority: z.enum(["Low", "Medium", "High", "Critical"]).optional().default("Medium"),
  dueDate: z.string().trim().max(40).optional().default(""),
  contactId: z.string().trim().nullable().optional().default(null),
  projectId: z.string().trim().nullable().optional().default(null),
  assignedToUserId: z.string().trim().nullable().optional().default(null),
  notes: optionalText
});

export const activitySchema = z.object({
  activityType: z.enum(["Note", "Call", "Meeting", "Email", "Site Visit", "Decision", "Risk", "Milestone"]).optional().default("Note"),
  body: z.string().trim().min(1).max(5000)
});

export const documentPatchSchema = z.object({
  notes: optionalText,
  documentCategory: z
    .enum(["Site Diligence", "Land Control", "Utility", "Design", "Permitting", "Capital", "Partner", "Operations", "General"])
    .optional()
    .default("General"),
  phase: z.enum(["Scouting", "Discovery", "Site Control", "Design", "Permitting", "Capital Stack", "Construction", "Operations", "General"]).optional().default("General"),
  contactIds: z.array(z.string()).optional().default([]),
  projectIds: z.array(z.string()).optional().default([])
});
