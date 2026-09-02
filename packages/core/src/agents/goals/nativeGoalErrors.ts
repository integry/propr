export class NativeGoalSessionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NativeGoalSessionError';
    }
}
