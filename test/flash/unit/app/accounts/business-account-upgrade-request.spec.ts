/* eslint-disable @typescript-eslint/no-explicit-any */

import { InvalidAccountStatusError, InvalidAccountLevelError } from "@domain/errors"

import { FileUploadError } from "@services/frappe/errors"

// Mock all external dependencies
const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockGetIdentity = jest.fn()
const mockCreateUpgradeRequest = jest.fn()
const mockUpdateAccountLevel = jest.fn()
const mockUploadFile = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findById: (...args: any[]) => mockFindAccountById(...args),
  }),
  UsersRepository: () => ({
    findById: (...args: any[]) => mockFindUserById(...args),
  }),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: () => ({
    getIdentity: (...args: any[]) => mockGetIdentity(...args),
  }),
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    createUpgradeRequest: (...args: any[]) => mockCreateUpgradeRequest(...args),
    uploadFile: (...args: any[]) => mockUploadFile(...args),
  },
}))

jest.mock("@app/accounts/update-account-level", () => ({
  updateAccountLevel: (...args: any[]) => mockUpdateAccountLevel(...args),
}))

import { businessAccountUpgradeRequest } from "@app/accounts/business-account-upgrade-request"

const baseAccount = {
  id: "account-123",
  username: "testuser",
  level: 1,
  kratosUserId: "kratos-user-123",
}

const baseUser = {
  id: "kratos-user-123",
  phone: "+18761234567",
}

const baseIdentity = {
  id: "kratos-user-123",
  email: "test@example.com",
}

describe("businessAccountUpgradeRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    // Default mock implementations
    mockFindAccountById.mockResolvedValue(baseAccount)
    mockFindUserById.mockResolvedValue(baseUser)
    mockGetIdentity.mockResolvedValue(baseIdentity)
    mockCreateUpgradeRequest.mockResolvedValue({ name: "REQ-001" })
    mockUpdateAccountLevel.mockResolvedValue(true)
    mockUploadFile.mockResolvedValue({ file_url: "/files/test.pdf" })
  })

  describe("successful requests", () => {
    it("creates upgrade request successfully with required fields only", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBe(true)
      expect(mockCreateUpgradeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          currentLevel: 1,
          requestedLevel: 2,
          username: "testuser",
          fullName: "Test User",
          phoneNumber: "+18761234567",
          email: "test@example.com",
        }),
      )
    })

    it("creates upgrade request with all optional business fields", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        businessName: "Test Business",
        businessAddress: "123 Main St",
        terminalRequested: true,
        bankName: "NCB",
        bankBranch: "Half Way Tree",
        accountType: "CHEQUING",
        currency: "JMD",
        accountNumber: 1234567890,
        idDocument: "passport.pdf",
      })

      expect(result).toBe(true)
      expect(mockCreateUpgradeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          businessName: "Test Business",
          businessAddress: "123 Main St",
          terminalRequested: true,
          bankName: "NCB",
          bankBranch: "Half Way Tree",
          accountType: "CHEQUING",
          currency: "JMD",
          accountNumber: 1234567890,
          idDocument: "passport.pdf",
        }),
      )
    })

    it("auto-upgrades account for Level 2 requests", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBe(true)
      expect(mockUpdateAccountLevel).toHaveBeenCalledWith({
        id: "account-123",
        level: 2,
      })
    })

    it("does not auto-upgrade for Level 3 requests", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 3,
        fullName: "Test User",
      })

      expect(result).toBe(true)
      expect(mockUpdateAccountLevel).not.toHaveBeenCalled()
    })
  })

  describe("phone number validation", () => {
    it("passes when provided phone matches stored phone", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18761234567",
      })

      expect(result).toBe(true)
    })

    it("fails when provided phone does not match stored phone", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18769999999",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Phone number does not match account records")
    })

    it("passes when phone is provided but account has no stored phone", async () => {
      mockFindUserById.mockResolvedValue({ ...baseUser, phone: "" })

      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18761234567",
      })

      expect(result).toBe(true)
    })

    it("passes when no phone is provided", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBe(true)
    })
  })

  describe("email validation", () => {
    it("passes when provided email matches stored email", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        email: "test@example.com",
      })

      expect(result).toBe(true)
    })

    it("fails when provided email does not match stored email", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        email: "wrong@example.com",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Email does not match account records")
    })

    it("passes when email is provided but account has no stored email", async () => {
      mockGetIdentity.mockResolvedValue({ ...baseIdentity, email: "" })

      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        email: "new@example.com",
      })

      expect(result).toBe(true)
    })

    it("passes when no email is provided", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBe(true)
    })
  })

  describe("level validation", () => {
    it("fails when requesting same level as current", async () => {
      mockFindAccountById.mockResolvedValue({ ...baseAccount, level: 2 })

      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Account is already at requested level")
    })

    it("fails when requesting downgrade", async () => {
      mockFindAccountById.mockResolvedValue({ ...baseAccount, level: 3 })

      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Cannot request account level downgrade")
    })

    it("fails with invalid level value", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 5,
        fullName: "Test User",
      })

      expect(result).toBeInstanceOf(InvalidAccountLevelError)
    })
  })

  describe("combined phone and email validation", () => {
    it("fails on phone mismatch even if email matches", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18769999999",
        email: "test@example.com",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Phone number does not match account records")
    })

    it("fails on email mismatch even if phone matches", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18761234567",
        email: "wrong@example.com",
      })

      expect(result).toBeInstanceOf(InvalidAccountStatusError)
      expect((result as any).message).toBe("Email does not match account records")
    })

    it("passes when both phone and email match", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        phoneNumber: "+18761234567",
        email: "test@example.com",
      })

      expect(result).toBe(true)
    })
  })

  describe("file upload via base64", () => {
    const base64PdfData = "data:application/pdf;base64,dGVzdCBwZGYgY29udGVudA=="

    it("uploads file when base64 data is provided in idDocument", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        idDocument: base64PdfData,
      })

      expect(result).toBe(true)
      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        "id-document-REQ-001.pdf",
        "Account Upgrade Request",
        "REQ-001",
      )
    })

    it("succeeds even when file upload fails", async () => {
      mockUploadFile.mockResolvedValue(new FileUploadError("Upload failed"))

      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        idDocument: base64PdfData,
      })

      expect(result).toBe(true)
    })

    it("does not upload file when idDocument is not base64", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
        idDocument: "passport.pdf", // Just a filename, not base64
      })

      expect(result).toBe(true)
      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it("does not upload file when idDocument is not provided", async () => {
      const result = await businessAccountUpgradeRequest({
        accountId: "account-123" as any,
        level: 2,
        fullName: "Test User",
      })

      expect(result).toBe(true)
      expect(mockUploadFile).not.toHaveBeenCalled()
    })
  })
})
