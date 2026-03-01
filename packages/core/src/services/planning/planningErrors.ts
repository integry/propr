/**
 * Error classes for the planning service.
 */

export class BranchNotFoundError extends Error {
  constructor(branch: string) {
    super(`Branch '${branch}' not found`);
    this.name = 'BranchNotFoundError';
  }
}

export class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}
