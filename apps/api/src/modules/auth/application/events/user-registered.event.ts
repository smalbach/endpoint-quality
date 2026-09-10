/** Published after the account and its organization exist. Nothing in the request path depends
 * on a subscriber having run — it is there for audit and, later, for the welcome mail. */
export class UserRegisteredEvent {
  constructor(readonly userId: string, readonly email: string, readonly organizationId: string, readonly at: Date) {}
}
