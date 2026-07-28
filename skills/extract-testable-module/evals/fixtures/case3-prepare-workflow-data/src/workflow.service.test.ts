import { AppError } from './app-error'
import { WorkflowService } from './workflow.service'
import type { WorkflowRepository } from './workflow.repository'

const repo: jest.Mocked<WorkflowRepository> = {
	create: jest.fn(),
	update: jest.fn(),
}

describe('WorkflowService.createWorkflow', () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('name を trim して保存する', async () => {
		repo.create.mockResolvedValue({ id: 'w1', name: 'テスト' })
		await new WorkflowService(repo).createWorkflow({ name: ' テスト ' })
		expect(repo.create).toHaveBeenCalledWith({ name: 'テスト' })
	})

	it('recurringExecution が不正な JSON なら AppError', async () => {
		await expect(new WorkflowService(repo).createWorkflow({ name: 'a', recurringExecution: 'x' })).rejects.toThrow(AppError)
	})
})
