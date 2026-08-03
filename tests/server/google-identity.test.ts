import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  HumanActorRecord,
  IdentityRepositoryPort,
} from "../../src/server/modules/identity/identity.repository.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";
import type { AuditInput } from "../../src/server/modules/audit/audit.repository.js";
import type { OutboxInput } from "../../src/server/modules/events/outbox.repository.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

function fakePool(): Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

function recordingPool(queries: string[]): Pool {
  const client = {
    query: async (sql: string) => {
      queries.push(sql.trim());
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

type GoogleHumanRecord = HumanActorRecord & { googleSubject: string | null };

function humanRecord(
  overrides: Partial<GoogleHumanRecord> = {},
): GoogleHumanRecord {
  return {
    actorId: randomUUID(),
    actorType: "human",
    actorName: "Provisioned Human",
    organizationId,
    role: "owner",
    userId: randomUUID(),
    email: "original@rangeway.energy",
    googleSubject: null,
    localPasswordHash: null,
    actorDisabledAt: null,
    userDisabledAt: null,
    ...overrides,
  };
}

class GoogleIdentityRepository {
  constructor(readonly humans: GoogleHumanRecord[]) {}

  async findHumanActorByGoogleSubject(
    scopedOrganizationId: string,
    googleSubject: string,
  ): Promise<GoogleHumanRecord | null> {
    return this.humans.find(
      (human) =>
        human.organizationId === scopedOrganizationId &&
        human.googleSubject === googleSubject,
    ) ?? null;
  }

  async findHumanActorByEmail(
    scopedOrganizationId: string,
    email: string,
  ): Promise<GoogleHumanRecord | null> {
    return this.humans.find(
      (human) =>
        human.organizationId === scopedOrganizationId && human.email === email,
    ) ?? null;
  }

  async findHumanActorByUserId(
    scopedOrganizationId: string,
    userId: string,
  ): Promise<GoogleHumanRecord | null> {
    return this.humans.find(
      (human) =>
        human.organizationId === scopedOrganizationId && human.userId === userId,
    ) ?? null;
  }

  async linkHumanActorToGoogle(
    scopedOrganizationId: string,
    userId: string,
    googleSubject: string,
    email: string,
    displayName: string,
  ): Promise<GoogleHumanRecord | null> {
    const human = await this.findHumanActorByUserId(scopedOrganizationId, userId);
    if (!human || human.googleSubject !== null) return null;
    if (this.humans.some(
      (candidate) =>
        candidate.userId !== userId &&
        (candidate.email === email || candidate.googleSubject === googleSubject),
    )) {
      throw Object.assign(new Error("duplicate identity"), { code: "23505" });
    }
    human.googleSubject = googleSubject;
    human.email = email;
    human.actorName = displayName;
    return human;
  }

  async updateHumanGoogleProfile(
    scopedOrganizationId: string,
    userId: string,
    googleSubject: string,
    email: string,
    displayName: string,
  ): Promise<GoogleHumanRecord | null> {
    const human = await this.findHumanActorByUserId(scopedOrganizationId, userId);
    if (!human || human.googleSubject !== googleSubject) return null;
    if (this.humans.some(
      (candidate) => candidate.userId !== userId && candidate.email === email,
    )) {
      throw Object.assign(new Error("duplicate email"), { code: "23505" });
    }
    human.email = email;
    human.actorName = displayName;
    return human;
  }
}

function service(
  repository: GoogleIdentityRepository,
  evidence: { audits: AuditInput[]; events: OutboxInput[] } = {
    audits: [],
    events: [],
  },
  precommitHook?: () => void | Promise<void>,
): IdentityService {
  return new IdentityService(
    fakePool(),
    repository as unknown as IdentityRepositoryPort,
    {
      recordAudit: async (input) => {
        evidence.audits.push(input);
      },
      enqueueEvent: async (input) => {
        evidence.events.push(input);
      },
      precommitHook,
    },
  );
}

const expectedUnauthenticated = {
  status: 401,
  code: "UNAUTHENTICATED",
  message: "Authentication required.",
};

describe("stable Google human identity binding", () => {
  it("links a verified Google subject to an explicitly provisioned human on first sign-in", async () => {
    const provisioned = humanRecord();
    const repository = new GoogleIdentityRepository([provisioned]);
    const evidence = { audits: [] as AuditInput[], events: [] as OutboxInput[] };
    const requestId = randomUUID();

    await expect(
      service(repository, evidence).authenticateGoogle(
        organizationId,
        "google-subject-001",
        "ORIGINAL@RANGEWAY.ENERGY",
        "Current Display Name",
        requestId,
      ),
    ).resolves.toMatchObject({
      actorId: provisioned.actorId,
      userId: provisioned.userId,
      organizationId,
    });

    expect(provisioned.googleSubject).toBe("google-subject-001");
    expect(provisioned.email).toBe("original@rangeway.energy");
    expect(provisioned.actorName).toBe("Current Display Name");
    expect(evidence.audits).toEqual([
      expect.objectContaining({
        organizationId,
        actorId: provisioned.actorId,
        requestId,
        action: "identity.google.linked",
        resourceType: "user",
        resourceId: provisioned.userId,
        before: {
          email: "original@rangeway.energy",
          displayName: "Provisioned Human",
          googleLinked: false,
        },
        after: {
          email: "original@rangeway.energy",
          displayName: "Current Display Name",
          googleLinked: true,
        },
        metadata: expect.objectContaining({
          subjectFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    ]);
    expect(evidence.events).toEqual([
      expect.objectContaining({
        eventType: "identity.google-linked.v1",
        payload: {
          organizationId,
          actorId: provisioned.actorId,
          userId: provisioned.userId,
          changedFields: ["googleSubject", "displayName"],
        },
      }),
    ]);
    expect(JSON.stringify(evidence.events)).not.toContain("google-subject-001");
    expect(JSON.stringify(evidence.events)).not.toContain("original@rangeway.energy");
  });

  it("resolves an already-linked human by organization and subject and accepts a verified email change", async () => {
    const linked = humanRecord({ googleSubject: "google-subject-001" });
    const repository = new GoogleIdentityRepository([linked]);
    const evidence = { audits: [] as AuditInput[], events: [] as OutboxInput[] };
    const requestId = randomUUID();

    await expect(
      service(repository, evidence).authenticateGoogle(
        organizationId,
        "google-subject-001",
        "renamed@rangeway.energy",
        "Renamed Human",
        requestId,
      ),
    ).resolves.toMatchObject({ actorId: linked.actorId, userId: linked.userId });

    expect(linked.email).toBe("renamed@rangeway.energy");
    expect(linked.actorName).toBe("Renamed Human");
    expect(evidence.audits).toEqual([
      expect.objectContaining({
        actorId: linked.actorId,
        requestId,
        action: "identity.google.profile_updated",
        before: {
          email: "original@rangeway.energy",
          displayName: "Provisioned Human",
        },
        after: {
          email: "renamed@rangeway.energy",
          displayName: "Renamed Human",
        },
      }),
    ]);
    expect(evidence.events).toEqual([
      expect.objectContaining({
        eventType: "identity.google-profile-updated.v1",
        payload: expect.objectContaining({
          changedFields: ["email", "displayName"],
        }),
      }),
    ]);
    expect(JSON.stringify(evidence.events)).not.toContain("renamed@rangeway.energy");
  });

  it("does not update or emit evidence when the verified identity is unchanged", async () => {
    const linked = humanRecord({
      googleSubject: "google-subject-001",
      email: "same@rangeway.energy",
      actorName: "Same Human",
    });
    const repository = new GoogleIdentityRepository([linked]);
    const update = vi.spyOn(repository, "updateHumanGoogleProfile");
    const evidence = { audits: [] as AuditInput[], events: [] as OutboxInput[] };

    await expect(
      service(repository, evidence).authenticateGoogle(
        organizationId,
        "google-subject-001",
        "same@rangeway.energy",
        "Same Human",
        randomUUID(),
      ),
    ).resolves.toMatchObject({ actorId: linked.actorId });

    expect(update).not.toHaveBeenCalled();
    expect(evidence).toEqual({ audits: [], events: [] });
  });

  it("rejects a different subject presented for an email that is already linked", async () => {
    const linked = humanRecord({ googleSubject: "original-google-subject" });
    const repository = new GoogleIdentityRepository([linked]);

    const evidence = { audits: [] as AuditInput[], events: [] as OutboxInput[] };
    await expect(
      service(repository, evidence).authenticateGoogle(
        organizationId,
        "attacker-google-subject",
        linked.email,
        "Attacker",
        randomUUID(),
      ),
    ).rejects.toMatchObject(expectedUnauthenticated);
    expect(linked.googleSubject).toBe("original-google-subject");
    expect(evidence).toEqual({ audits: [], events: [] });
  });

  it("rolls back the Google link transaction when evidence publication fails", async () => {
    const provisioned = humanRecord();
    const repository = new GoogleIdentityRepository([provisioned]);
    const queries: string[] = [];
    const identity = new IdentityService(
      recordingPool(queries),
      repository as unknown as IdentityRepositoryPort,
      {
        recordAudit: async () => undefined,
        enqueueEvent: async () => {
          throw new Error("forced outbox failure");
        },
      },
    );

    await expect(
      identity.authenticateGoogle(
        organizationId,
        "google-subject-rollback",
        provisioned.email,
        provisioned.actorName,
        randomUUID(),
      ),
    ).rejects.toThrow("forced outbox failure");
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rejects a linked subject when its new email belongs to another provisioned human", async () => {
    const linked = humanRecord({
      googleSubject: "google-subject-001",
      email: "old@rangeway.energy",
    });
    const recycledAddressOwner = humanRecord({ email: "new@rangeway.energy" });
    const repository = new GoogleIdentityRepository([linked, recycledAddressOwner]);

    await expect(
      service(repository).authenticateGoogle(
        organizationId,
        "google-subject-001",
        recycledAddressOwner.email,
        "Linked Human",
        randomUUID(),
      ),
    ).rejects.toMatchObject(expectedUnauthenticated);
    expect(linked.email).toBe("old@rangeway.energy");
  });

  it("revalidates a signed human session by organization and immutable user id, not email", async () => {
    const original = humanRecord({ email: "recycled@rangeway.energy" });
    const repository = new GoogleIdentityRepository([original]);

    await expect(
      service(repository).authenticateHumanSession(
        organizationId,
        original.userId,
      ),
    ).resolves.toMatchObject({ actorId: original.actorId, userId: original.userId });

    await expect(
      service(repository).authenticateHumanSession(
        organizationId,
        randomUUID(),
      ),
    ).rejects.toMatchObject(expectedUnauthenticated);
  });
});
