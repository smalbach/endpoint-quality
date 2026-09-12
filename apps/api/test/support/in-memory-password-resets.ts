import type { PasswordResetRepositoryPort, PasswordResetToken } from "@/modules/auth/domain/password-reset";

export class InMemoryPasswordResetRepository implements PasswordResetRepositoryPort {
  readonly rows = new Map<string, PasswordResetToken>();

  async save(token: PasswordResetToken): Promise<void> {
    this.rows.set(token.id, { ...token });
  }
  async findByHash(hash: string): Promise<PasswordResetToken | null> {
    return [...this.rows.values()].find((token) => token.tokenHash === hash) ?? null;
  }
  async spendAllForUser(userId: string, at: Date): Promise<void> {
    for (const [id, token] of this.rows) {
      if (token.userId === userId && !token.usedAt) this.rows.set(id, { ...token, usedAt: at });
    }
  }
}
