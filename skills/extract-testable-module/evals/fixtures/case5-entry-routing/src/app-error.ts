export const AppErrorCodes = {
	InvalidArgument: 'INVALID_ARGUMENT',
} as const

export type AppErrorCode = (typeof AppErrorCodes)[keyof typeof AppErrorCodes]

export class AppError extends Error {
	constructor(
		readonly code: AppErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'AppError'
	}
}
