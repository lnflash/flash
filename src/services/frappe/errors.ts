import { DomainError } from "@domain/shared";

export class ErpNextError extends DomainError {}
export class JournalEntryDraftError extends ErpNextError {}
export class JournalEntryTitleError extends JournalEntryDraftError {}
export class JournalEntrySubmitError extends ErpNextError {}
export class JournalEntryDeleteError extends ErpNextError {}
export class IssueCreateError extends ErpNextError {}
export class IssueQueryError extends ErpNextError {}
