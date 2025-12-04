/**
 * ERPNext/Frappe Service Error Classes
 *
 * These errors are thrown when ERPNext API operations fail.
 * They extend DomainError for consistent error handling across the application.
 */
import { DomainError } from "@domain/shared"

/** Base error class for all ERPNext-related errors */
export class ErpNextError extends DomainError {}

// Journal Entry errors (for cashout accounting)
export class JournalEntryDraftError extends ErpNextError {}
export class JournalEntryTitleError extends JournalEntryDraftError {}
export class JournalEntrySubmitError extends ErpNextError {}
export class JournalEntryDeleteError extends ErpNextError {}

// Account Upgrade Request errors (for business account upgrades)
/** Thrown when creating an Account Upgrade Request in ERPNext fails */
export class UpgradeRequestCreateError extends ErpNextError {}
/** Thrown when querying pending Account Upgrade Requests fails */
export class UpgradeRequestQueryError extends ErpNextError {}
