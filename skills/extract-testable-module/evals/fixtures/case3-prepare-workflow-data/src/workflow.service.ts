import { AppError, AppErrorCodes } from './app-error'
import type { CreateWorkflowRequest, RecurringExecution, Workflow, WorkflowCreateInput } from './types'
import type { WorkflowRepository } from './workflow.repository'

export class WorkflowService {
	constructor(private readonly repo: WorkflowRepository) {}

	async createWorkflow(req: CreateWorkflowRequest): Promise<Workflow> {
		const data = this.prepareWorkflowData(req)
		return this.repo.create(data)
	}

	async updateWorkflow(id: string, req: CreateWorkflowRequest): Promise<Workflow> {
		const data = this.prepareWorkflowData(req)
		return this.repo.update(id, data)
	}

	private prepareWorkflowData(req: CreateWorkflowRequest): WorkflowCreateInput {
		if (!req.name || req.name.trim() === '') {
			throw new AppError(AppErrorCodes.InvalidArgument, 'name は必須です')
		}
		const data: WorkflowCreateInput = { name: req.name.trim() }
		if (req.recurringExecution) {
			let recurring: RecurringExecution
			try {
				recurring = JSON.parse(req.recurringExecution)
			} catch {
				throw new AppError(AppErrorCodes.InvalidArgument, 'recurringExecution が不正な JSON です')
			}
			if (typeof recurring.intervalDays !== 'number' || recurring.intervalDays <= 0) {
				throw new AppError(AppErrorCodes.InvalidArgument, 'intervalDays は正の数である必要があります')
			}
			data.recurringExecution = recurring
		}
		if (req.nodes) {
			let parsed: unknown
			try {
				parsed = JSON.parse(req.nodes)
			} catch {
				throw new AppError(AppErrorCodes.InvalidArgument, 'nodes が不正な JSON です')
			}
			if (!Array.isArray(parsed)) {
				throw new AppError(AppErrorCodes.InvalidArgument, 'nodes は配列である必要があります')
			}
			data.nodeCount = parsed.length
		}
		return data
	}
}
