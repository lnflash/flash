import { ApiKeyAzRspHarness, TaskCategory, Task, Solution } from './az-rsp-harness';

describe("ApiKeyAzRspHarness", () => {
  let harness: ApiKeyAzRspHarness;

  beforeEach(() => {
    harness = new ApiKeyAzRspHarness();
  });

  describe("Task generation", () => {
    it("should generate a security task", () => {
      const task = harness.generateTask(TaskCategory.SECURITY);
      
      expect(task).toBeDefined();
      expect(task.category).toBe(TaskCategory.SECURITY);
      expect(task.name).toBeDefined();
      expect(task.description).toBeDefined();
      expect(task.validationCriteria.length).toBeGreaterThan(0);
      expect(task.difficulty).toBeGreaterThanOrEqual(1);
      expect(task.difficulty).toBeLessThanOrEqual(5);
    });

    it("should generate a performance task", () => {
      const task = harness.generateTask(TaskCategory.PERFORMANCE);
      
      expect(task).toBeDefined();
      expect(task.category).toBe(TaskCategory.PERFORMANCE);
      expect(task.validationCriteria.length).toBeGreaterThan(0);
    });

    it("should generate a usability task", () => {
      const task = harness.generateTask(TaskCategory.USABILITY);
      
      expect(task).toBeDefined();
      expect(task.category).toBe(TaskCategory.USABILITY);
      expect(task.validationCriteria.length).toBeGreaterThan(0);
    });

    it("should generate a feature task", () => {
      const task = harness.generateTask(TaskCategory.FEATURE);
      
      expect(task).toBeDefined();
      expect(task.category).toBe(TaskCategory.FEATURE);
      expect(task.validationCriteria.length).toBeGreaterThan(0);
    });
  });

  describe("Task verification", () => {
    it("should reject tasks with no validation criteria", () => {
      const invalidTask: Task = {
        name: "Invalid Task",
        category: TaskCategory.SECURITY,
        description: "A task with no validation criteria",
        difficulty: 3,
        validationCriteria: [],
        inputType: "string",
        outputType: "boolean"
      };
      
      const result = harness.verifyTask(invalidTask);
      expect(result.success).toBe(false);
      expect(result.error).toContain("must have at least one validation criterion");
    });

    it("should reject tasks with invalid difficulty", () => {
      const invalidTask: Task = {
        name: "Invalid Task",
        category: TaskCategory.SECURITY,
        description: "A task with invalid difficulty",
        difficulty: 6, // Invalid: outside 1-5 range
        validationCriteria: ["Should do something"],
        inputType: "string",
        outputType: "boolean"
      };
      
      const result = harness.verifyTask(invalidTask);
      expect(result.success).toBe(false);
      expect(result.error).toContain("difficulty must be between 1 and 5");
    });
  });

  describe("Solution verification", () => {
    it("should accept a valid solution that meets all criteria", () => {
      const task: Task = {
        name: "Implement Timing-Safe API Key Verification",
        category: TaskCategory.SECURITY,
        description: "Enhance the API key verification to use timing-safe comparison",
        difficulty: 3,
        validationCriteria: [
          "Must use crypto.timingSafeEqual()",
          "Must handle error cases gracefully"
        ],
        inputType: "string",
        outputType: "boolean"
      };
      
      const solution: Solution = {
        code: `
          import { timingSafeEqual } from 'crypto';
          
          export function verifyApiKey(key: string, storedHash: string): boolean {
            try {
              const keyBuffer = Buffer.from(hashApiKey(key), 'hex');
              const storedBuffer = Buffer.from(storedHash, 'hex');
              
              // Ensure buffers are the same length for timing-safe comparison
              if (keyBuffer.length !== storedBuffer.length) {
                return false;
              }
              
              return timingSafeEqual(keyBuffer, storedBuffer);
            } catch (error) {
              console.error('Error verifying API key:', error);
              return false;
            }
          }
        `,
        explanation: "This solution implements timing-safe comparison for API keys using crypto.timingSafeEqual(). It properly handles errors and ensures the buffers are the same length before comparison.",
        inputType: "string",
        outputType: "boolean"
      };
      
      const result = harness.verifySolution(task, solution);
      expect(result.success).toBe(true);
    });

    it("should reject a solution with mismatched input/output types", () => {
      const task: Task = {
        name: "Test Task",
        category: TaskCategory.SECURITY,
        description: "A test task",
        difficulty: 3,
        validationCriteria: ["Must do something"],
        inputType: "string",
        outputType: "boolean"
      };
      
      const solution: Solution = {
        code: "function test(input: number): string { return 'test'; }",
        explanation: "This doesn't match the required types",
        inputType: "number", // Mismatch with task
        outputType: "string" // Mismatch with task
      };
      
      const result = harness.verifySolution(task, solution);
      expect(result.success).toBe(false);
      expect(result.error).toContain("IO types");
    });
  });

  describe("Full workflow", () => {
    it("should complete a full task and solution cycle", () => {
      // Generate a task
      const task = harness.generateTask(TaskCategory.SECURITY);
      
      // Create a matching solution
      const solution: Solution = {
        code: `
          import { timingSafeEqual } from 'crypto';
          
          /**
           * Verifies an API key using timing-safe comparison to prevent timing attacks
           */
          export function verifyApiKey(key: string, storedHash: string): boolean {
            try {
              // Extract keyId from format fk_keyId_randomBits
              const parts = key.split('_');
              if (parts.length !== 3 || parts[0] !== 'fk') {
                return false;
              }
              
              const computedHash = hashApiKey(key);
              const keyBuffer = Buffer.from(computedHash, 'hex');
              const storedBuffer = Buffer.from(storedHash, 'hex');
              
              // Ensure buffers are the same length for timing-safe comparison
              if (keyBuffer.length !== storedBuffer.length) {
                return false;
              }
              
              return timingSafeEqual(keyBuffer, storedBuffer);
            } catch (error) {
              console.error('Error verifying API key:', error);
              return false;
            }
          }
          
          /**
           * Hash an API key using SHA-256
           */
          function hashApiKey(key: string): string {
            const crypto = require('crypto');
            return crypto.createHash('sha256').update(key).digest('hex');
          }
        `,
        explanation: `
          This solution implements timing-safe API key verification to prevent timing attacks.
          
          Key security features:
          1. Uses crypto.timingSafeEqual() for constant-time comparison
          2. Ensures the buffers are the same length before comparison
          3. Properly validates the API key format before processing
          4. Includes comprehensive error handling
          5. Uses SHA-256 for secure hashing
          
          This prevents attackers from using timing differences to gradually determine valid API keys.
        `,
        inputType: task.inputType,
        outputType: task.outputType
      };
      
      // Attempt the solution
      const solutionRecord = harness.attemptSolution(task, solution);
      
      // Check the result
      expect(solutionRecord).toBeDefined();
      expect(solutionRecord.feedback).toBeDefined();
      
      // Get statistics
      const stats = harness.getStatistics();
      expect(stats.totalTasks).toBeGreaterThan(0);
    });
  });
});