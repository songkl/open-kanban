import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunTimeline } from './RunTimeline';
import type { TaskRun } from '@/types/kanban';

const baseRun: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  runnerId: 'runner-9af0',
  agentId: 'agent-1',
  status: 'claimed',
  claimedAt: '2026-09-17T10:00:00.000Z',
  lastHeartbeatAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T10:02:00.000Z',
  finishedAt: null,
  exitCode: null,
  error: null,
};

describe('RunTimeline', () => {
  it('renders three steps and the title bar', () => {
    render(<RunTimeline run={baseRun} />);
    expect(screen.getByTestId('run-timeline')).toBeInTheDocument();
    expect(screen.getByText('taskModal.runTimelineTitle')).toBeInTheDocument();
    expect(screen.getByText('taskModal.runTimelineStepClaimed')).toBeInTheDocument();
    expect(screen.getByText('taskModal.runTimelineStepRunning')).toBeInTheDocument();
    expect(screen.getByText('taskModal.runTimelineStepFinished')).toBeInTheDocument();
  });

  it('marks the claimed step as active when status is claimed', () => {
    render(<RunTimeline run={baseRun} />);
    expect(screen.getByTestId('run-timeline')).toHaveAttribute('data-status', 'claimed');
    const claimedNode = document.querySelector('[data-step="claimed"]');
    expect(claimedNode).toHaveAttribute('data-state', 'active');
    expect(document.querySelector('[data-step="running"]')).toHaveAttribute('data-state', 'pending');
    expect(document.querySelector('[data-step="finished"]')).toHaveAttribute('data-state', 'pending');
  });

  it('moves the active step forward as the run progresses', () => {
    render(<RunTimeline run={{ ...baseRun, status: 'running' }} />);
    expect(document.querySelector('[data-step="claimed"]')).toHaveAttribute('data-state', 'done');
    expect(document.querySelector('[data-step="running"]')).toHaveAttribute('data-state', 'active');
    expect(document.querySelector('[data-step="finished"]')).toHaveAttribute('data-state', 'pending');
  });

  it('marks every step as done and surfaces finished timestamp when completed', () => {
    render(
      <RunTimeline
        run={{
          ...baseRun,
          status: 'completed',
          finishedAt: '2026-09-17T10:01:30.000Z',
          exitCode: 0,
        }}
      />
    );
    expect(document.querySelector('[data-step="claimed"]')).toHaveAttribute('data-state', 'done');
    expect(document.querySelector('[data-step="running"]')).toHaveAttribute('data-state', 'done');
    expect(document.querySelector('[data-step="finished"]')).toHaveAttribute('data-state', 'active');
    expect(screen.getByText(/taskModal.runFinishedAt/)).toBeInTheDocument();
  });

  it('still reaches the finished step on failure', () => {
    render(
      <RunTimeline
        run={{
          ...baseRun,
          status: 'failed',
          finishedAt: '2026-09-17T10:01:00.000Z',
          exitCode: 1,
        }}
      />
    );
    expect(document.querySelector('[data-step="finished"]')).toHaveAttribute('data-state', 'active');
  });
});