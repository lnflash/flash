import { ApiKeyVerifiableEnvironment, ValidationResult } from './verifiable-environment';

/**
 * AZ-RSP (Absolute Zero Reinforced Self-Play) Harness
 * 
 * This class implements the AZ-RSP methodology for API key enhancements:
 * - Generates self-proposed tasks for API key improvements
 * - Implements solutions to those tasks
 * - Verifies both tasks and solutions using objective criteria
 * - Reinforces learning through feedback
 */
export class ApiKeyAzRspHarness {
  private environment: ApiKeyVerifiableEnvironment;
  private taskHistory: TaskRecord[] = [];
  private solutionHistory: SolutionRecord[] = [];

  constructor() {
    this.environment = new ApiKeyVerifiableEnvironment();
  }

  /**
   * Generate a task based on predefined categories
   * @param category Task category
   * @returns The generated task
   */
  generateTask(category: TaskCategory): Task {
    const taskGenerators: Record<TaskCategory, () => Task> = {
      [TaskCategory.SECURITY]: this.generateSecurityTask.bind(this),
      [TaskCategory.PERFORMANCE]: this.generatePerformanceTask.bind(this),
      [TaskCategory.USABILITY]: this.generateUsabilityTask.bind(this),
      [TaskCategory.FEATURE]: this.generateFeatureTask.bind(this)
    };

    const task = taskGenerators[category]();
    this.taskHistory.push({
      task,
      timestamp: new Date(),
      verificationResult: this.verifyTask(task)
    });

    return task;
  }

  /**
   * Verify a task for quality and feasibility
   * @param task The task to verify
   * @returns Validation result
   */
  verifyTask(task: Task): ValidationResult {
    // Check if similar task already exists
    const similarTask = this.taskHistory.find(record => 
      record.task.name === task.name ||
      record.task.description.toLowerCase() === task.description.toLowerCase()
    );

    if (similarTask) {
      return {
        success: false,
        error: `Task is too similar to existing task: ${similarTask.task.name}`
      };
    }

    // Ensure the task has clear validation criteria
    if (!task.validationCriteria || task.validationCriteria.length === 0) {
      return {
        success: false,
        error: 'Task must have at least one validation criterion'
      };
    }

    // Ensure the task has a clear difficulty level
    if (task.difficulty < 1 || task.difficulty > 5) {
      return {
        success: false,
        error: 'Task difficulty must be between 1 and 5'
      };
    }

    return { success: true };
  }

  /**
   * Attempt to solve a given task
   * @param task The task to solve
   * @param solution The proposed solution
   * @returns Solution record with verification results
   */
  attemptSolution(task: Task, solution: Solution): SolutionRecord {
    const verificationResult = this.verifySolution(task, solution);
    
    const record: SolutionRecord = {
      task,
      solution,
      timestamp: new Date(),
      verificationResult,
      feedback: this.generateFeedback(task, solution, verificationResult)
    };

    this.solutionHistory.push(record);
    return record;
  }

  /**
   * Verify a solution against task criteria
   * @param task The original task
   * @param solution The proposed solution
   * @returns Validation result
   */
  verifySolution(task: Task, solution: Solution): ValidationResult {
    // Check if the solution addresses all validation criteria
    for (const criterion of task.validationCriteria) {
      // This would involve custom validation logic based on the criterion
      // For now, we'll use a simple check for keyword presence
      const criterionKeywords = criterion.toLowerCase().split(' ');
      const isCriterionAddressed = criterionKeywords.some(keyword => 
        solution.code.toLowerCase().includes(keyword) || 
        solution.explanation.toLowerCase().includes(keyword)
      );

      if (!isCriterionAddressed) {
        return {
          success: false,
          error: `Solution does not address criterion: ${criterion}`
        };
      }
    }

    // Ensure solution matches the expected input and output types
    if (solution.inputType !== task.inputType || solution.outputType !== task.outputType) {
      return {
        success: false,
        error: `Solution IO types (${solution.inputType} -> ${solution.outputType}) ` +
               `don't match task requirements (${task.inputType} -> ${task.outputType})`
      };
    }

    return { success: true };
  }

  /**
   * Generate feedback for a solution attempt
   * @param task The original task
   * @param solution The proposed solution
   * @param verificationResult Result of solution verification
   * @returns Structured feedback
   */
  generateFeedback(
    task: Task, 
    solution: Solution, 
    verificationResult: ValidationResult
  ): TaskFeedback {
    return {
      correctness: verificationResult.success ? 5 : 2,
      completeness: this.evaluateCompleteness(task, solution),
      codeQuality: this.evaluateCodeQuality(solution),
      securityScore: this.evaluateSecurityScore(solution),
      performanceScore: this.evaluatePerformanceScore(solution),
      comments: verificationResult.success 
        ? ['Solution successfully addresses all criteria'] 
        : [verificationResult.error || 'Solution does not meet all requirements']
    };
  }

  /**
   * Generates statistics about task and solution history
   * @returns Statistics summary
   */
  getStatistics(): HarnessStatistics {
    return {
      totalTasks: this.taskHistory.length,
      completedTasks: this.solutionHistory.filter(s => s.verificationResult.success).length,
      failedTasks: this.solutionHistory.filter(s => !s.verificationResult.success).length,
      averageFeedbackScores: this.calculateAverageFeedback(),
      tasksByCategory: this.countTasksByCategory()
    };
  }

  /**
   * Generate a task focusing on security improvements
   * @returns Security focused task
   */
  private generateSecurityTask(): Task {
    return {
      name: "Implement Timing-Safe API Key Verification",
      category: TaskCategory.SECURITY,
      description: 
        "Enhance the API key verification process to use timing-safe comparison " +
        "to protect against timing attacks that could leak information about valid keys.",
      difficulty: 3,
      validationCriteria: [
        "Must use crypto.timingSafeEqual() for comparing key hashes",
        "Must perform comparison on Buffer objects of equal length",
        "Must handle error cases gracefully",
        "Must have unit tests demonstrating protection against timing attacks"
      ],
      inputType: "string",
      outputType: "boolean | ApiKey"
    };
  }

  /**
   * Generate a task focusing on performance improvements
   * @returns Performance focused task
   */
  private generatePerformanceTask(): Task {
    return {
      name: "Optimize API Key Rate Limiting",
      category: TaskCategory.PERFORMANCE,
      description: 
        "Enhance the rate limiting system for API keys to reduce Redis operations " +
        "and improve throughput during high-traffic periods.",
      difficulty: 4,
      validationCriteria: [
        "Must reduce the number of Redis operations per request",
        "Must maintain accurate rate limit tracking",
        "Must include a local cache to reduce network calls",
        "Must have benchmarks showing at least 20% throughput improvement"
      ],
      inputType: "ApiKey",
      outputType: "RateLimitResult"
    };
  }

  /**
   * Generate a task focusing on usability improvements
   * @returns Usability focused task
   */
  private generateUsabilityTask(): Task {
    return {
      name: "Implement API Key User-Friendly Display Format",
      category: TaskCategory.USABILITY,
      description: 
        "Create a system to display API keys in a more user-friendly format while maintaining " +
        "security, including partial masking and formatting for readability.",
      difficulty: 2,
      validationCriteria: [
        "Must partially mask keys when displayed (show only first and last few characters)",
        "Must group characters for better readability (like UUID format)",
        "Must provide a copy function that reveals the full key only temporarily",
        "Must have consistent formatting across all UI components"
      ],
      inputType: "string",
      outputType: "string"
    };
  }

  /**
   * Generate a task focusing on new features
   * @returns Feature focused task
   */
  private generateFeatureTask(): Task {
    return {
      name: "Implement API Key Auto-Rotation System",
      category: TaskCategory.FEATURE,
      description: 
        "Create a system that automatically rotates API keys based on age, usage patterns, " +
        "or scheduled policies, with a grace period to ensure service continuity.",
      difficulty: 5,
      validationCriteria: [
        "Must support time-based rotation policies (30/60/90 day schedules)",
        "Must support usage-based rotation (after X thousand uses)",
        "Must have a configurable grace period where both old and new keys work",
        "Must notify users before rotation via webhooks, email or UI",
        "Must maintain a history of rotated keys with timestamps"
      ],
      inputType: "ApiKey, RotationPolicy",
      outputType: "RotationResult"
    };
  }

  /**
   * Evaluate the completeness of a solution
   * @param task The original task
   * @param solution The solution to evaluate
   * @returns Completeness score (1-5)
   */
  private evaluateCompleteness(task: Task, solution: Solution): number {
    // Count how many validation criteria are mentioned in the solution
    let criteriaAddressed = 0;
    
    for (const criterion of task.validationCriteria) {
      const keywords = criterion.toLowerCase().split(' ')
        .filter(word => word.length > 3); // Filter out short words
      
      const isCriterionAddressed = keywords.some(keyword => 
        solution.code.toLowerCase().includes(keyword) || 
        solution.explanation.toLowerCase().includes(keyword)
      );
      
      if (isCriterionAddressed) {
        criteriaAddressed++;
      }
    }
    
    // Calculate score based on percentage of criteria addressed
    const percentage = criteriaAddressed / task.validationCriteria.length;
    return Math.max(1, Math.min(5, Math.round(percentage * 5)));
  }

  /**
   * Evaluate the code quality of a solution
   * @param solution The solution to evaluate
   * @returns Code quality score (1-5)
   */
  private evaluateCodeQuality(solution: Solution): number {
    // This would be more sophisticated in production
    // For now, use simple heuristics
    
    // Check for comments
    const hasComments = solution.code.includes('//') || solution.code.includes('/*');
    
    // Check for error handling
    const hasErrorHandling = solution.code.includes('try') && solution.code.includes('catch');
    
    // Check for TypeScript typing
    const hasTyping = solution.code.includes(': ') && !solution.code.includes('any');
    
    // Base score
    let score = 3;
    
    if (hasComments) score += 0.5;
    if (hasErrorHandling) score += 0.5;
    if (hasTyping) score += 1;
    
    // Penalty for very short solutions
    if (solution.code.split('\n').length < 5) score -= 1;
    
    return Math.max(1, Math.min(5, Math.round(score)));
  }

  /**
   * Evaluate the security aspects of a solution
   * @param solution The solution to evaluate
   * @returns Security score (1-5)
   */
  private evaluateSecurityScore(solution: Solution): number {
    // Security keywords to look for
    const securityKeywords = [
      'timingSafeEqual',
      'crypto',
      'hash',
      'validate',
      'sanitize',
      'escape',
      'authorization',
      'authentication'
    ];
    
    // Count occurrences of security keywords
    const matchCount = securityKeywords.filter(keyword => 
      solution.code.toLowerCase().includes(keyword.toLowerCase())
    ).length;
    
    // Base score on keyword matches
    let score = Math.min(5, 1 + matchCount);
    
    // Penalties for security red flags
    const securityRedFlags = [
      'eval(',
      'exec(',
      'Object.assign({},',
      '== null',
      '!= null',
      'innerHTML'
    ];
    
    const redFlagCount = securityRedFlags.filter(flag => 
      solution.code.includes(flag)
    ).length;
    
    score = Math.max(1, score - redFlagCount);
    
    return score;
  }

  /**
   * Evaluate the performance aspects of a solution
   * @param solution The solution to evaluate
   * @returns Performance score (1-5)
   */
  private evaluatePerformanceScore(solution: Solution): number {
    // Performance keywords to look for
    const performanceKeywords = [
      'cache',
      'index',
      'optimiz',
      'batch',
      'parallel',
      'memory',
      'efficient',
      'performance'
    ];
    
    // Count occurrences of performance keywords
    const matchCount = performanceKeywords.filter(keyword => 
      solution.code.toLowerCase().includes(keyword.toLowerCase()) ||
      solution.explanation.toLowerCase().includes(keyword.toLowerCase())
    ).length;
    
    // Base score on keyword matches
    let score = Math.min(5, 2 + matchCount);
    
    // Penalties for performance red flags
    const performanceRedFlags = [
      '.forEach(',
      'for (let i',
      'while (',
      '.map(',
      '.filter('
    ];
    
    // Check for nested loops which indicate potential O(n²) complexity
    const hasNestedLoops = (solution.code.match(/for\s*\(/g) || []).length > 1 &&
                           solution.code.includes('for') && 
                           solution.code.split('for').some(part => part.includes('for'));
    
    const redFlagCount = performanceRedFlags.filter(flag => 
      solution.code.includes(flag)
    ).length;
    
    if (hasNestedLoops) score = Math.max(1, score - 1);
    score = Math.max(1, score - Math.min(2, redFlagCount));
    
    return score;
  }

  /**
   * Calculate average feedback scores across all solutions
   * @returns Average feedback scores
   */
  private calculateAverageFeedback(): AverageFeedback {
    if (this.solutionHistory.length === 0) {
      return {
        correctness: 0,
        completeness: 0,
        codeQuality: 0,
        securityScore: 0,
        performanceScore: 0
      };
    }
    
    let totalCorrectness = 0;
    let totalCompleteness = 0;
    let totalCodeQuality = 0;
    let totalSecurityScore = 0;
    let totalPerformanceScore = 0;
    
    for (const record of this.solutionHistory) {
      totalCorrectness += record.feedback.correctness;
      totalCompleteness += record.feedback.completeness;
      totalCodeQuality += record.feedback.codeQuality;
      totalSecurityScore += record.feedback.securityScore;
      totalPerformanceScore += record.feedback.performanceScore;
    }
    
    const count = this.solutionHistory.length;
    
    return {
      correctness: parseFloat((totalCorrectness / count).toFixed(2)),
      completeness: parseFloat((totalCompleteness / count).toFixed(2)),
      codeQuality: parseFloat((totalCodeQuality / count).toFixed(2)),
      securityScore: parseFloat((totalSecurityScore / count).toFixed(2)),
      performanceScore: parseFloat((totalPerformanceScore / count).toFixed(2))
    };
  }

  /**
   * Count tasks by category
   * @returns Count of tasks in each category
   */
  private countTasksByCategory(): Record<TaskCategory, number> {
    const counts = {
      [TaskCategory.SECURITY]: 0,
      [TaskCategory.PERFORMANCE]: 0,
      [TaskCategory.USABILITY]: 0,
      [TaskCategory.FEATURE]: 0
    };
    
    for (const record of this.taskHistory) {
      counts[record.task.category]++;
    }
    
    return counts;
  }
}

/**
 * Task category enum
 */
export enum TaskCategory {
  SECURITY = "security",
  PERFORMANCE = "performance",
  USABILITY = "usability",
  FEATURE = "feature",
}

/**
 * Task interface
 */
export interface Task {
  name: string;
  category: TaskCategory;
  description: string;
  difficulty: number; // 1-5 scale
  validationCriteria: string[];
  inputType: string;
  outputType: string;
}

/**
 * Solution interface
 */
export interface Solution {
  code: string;
  explanation: string;
  inputType: string;
  outputType: string;
}

/**
 * Task record interface
 */
export interface TaskRecord {
  task: Task;
  timestamp: Date;
  verificationResult: ValidationResult;
}

/**
 * Solution record interface
 */
export interface SolutionRecord {
  task: Task;
  solution: Solution;
  timestamp: Date;
  verificationResult: ValidationResult;
  feedback: TaskFeedback;
}

/**
 * Task feedback interface
 */
export interface TaskFeedback {
  correctness: number; // 1-5 scale
  completeness: number; // 1-5 scale
  codeQuality: number; // 1-5 scale
  securityScore: number; // 1-5 scale
  performanceScore: number; // 1-5 scale
  comments: string[];
}

/**
 * Average feedback interface
 */
export interface AverageFeedback {
  correctness: number;
  completeness: number;
  codeQuality: number;
  securityScore: number;
  performanceScore: number;
}

/**
 * Harness statistics interface
 */
export interface HarnessStatistics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageFeedbackScores: AverageFeedback;
  tasksByCategory: Record<TaskCategory, number>;
}