import type { Workflow, WorkflowCreateInput } from './types'

export interface WorkflowRepository {
	create(input: WorkflowCreateInput): Promise<Workflow>
	update(id: string, input: WorkflowCreateInput): Promise<Workflow>
}
