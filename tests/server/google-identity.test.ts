import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type {
  HumanActorRecord,
  IdentityRepositoryPort,
} from "../../src/server/modules/identity/identity.repository.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

function fakePool(): Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
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

function service(repository: GoogleIdentityRepository): IdentityService {
  return new IdentityService(
    fakePool(),
    repository as unknown as IdentityRepositoryPort,
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

    await expect(
      service(repository).authenticateGoogle(
        organizationId,
        "google-subject-001",
        "ORIGINAL@RANGEWAY.ENERGY",
        "Current Display Name",
      ),
    ).resolves.toMatchObject({
      actorId: provisioned.actorId,
      userId: provisioned.userId,
      organizationId,
    });

    expect(provisioned.googleSubject).toBe("google-subject-001");
    expect(provisioned.email).toBe("original@rangeway.energy");
    expect(provisioned.actorName).toBe("Current Display Name");
  });

  it("resolves an already-linked human by organization and subject and accepts a verified email change", async () => {
    const linked = humanRecord({ googleSubject: "google-subject-001" });
    const repository = new GoogleIdentityRepository([linked]);

    await expect(
      service(repository).authenticateGoogle(
        organizationId,
        "google-subject-001",
        "renamed@rangeway.energy",
        "Renamed Human",
      ),
    ).resolves.toMatchObject({ actorId: linked.actorId, userId: linked.userId });

    expect(linked.email).toBe("renamed@rangeway.energy");
    expect(linked.actorName).toBe("Renamed Human");
  });

  it("rejects a different subject presented for an email that is already linked", async () => {
    const linked = humanRecord({ googleSubject: "original-google-subject" });
    const repository = new GoogleIdentityRepository([linked]);

    await expect(
      service(repository).authenticateGoogle(
        organizationId,
        "attacker-google-subject",
        linked.email,
        "Attacker",
      ),
    ).rejects.toMatchObject(expectedUnauthenticated);
    expect(linked.googleSubject).toBe("original-google-subject");
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
