export interface CreateWorkflowRequest {
	name: string
	recurringExecution?: string
	nodes?: string
}

export interface RecurringExecution {
	intervalDays: number
	startAt?: string
}

export interface WorkflowCreateInput {
	name: string
	recurringExecution?: RecurringExecution
	nodeCount?: number
}

export interface Workflow {
	id: string
	name: string
}
