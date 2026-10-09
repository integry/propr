import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AttributedUser } from '@propr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiClientMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  handleApiResponse: vi.fn(),
}));

vi.mock('../api/apiClient', () => ({
  API_BASE_URL: 'https://api.propr.test',
  ...apiClientMocks,
}));

import { getAssignableUsers, getTaskAssignees, setTaskAssignees, TaskAssigneesRejectedError } from '../api/taskAssignment';
import {
  ASSIGNEE_STACK_LIMIT,
  AssigneeChip,
  AssigneeList,
  AssigneeStack,
  UnassignedMarker,
} from './AssigneeList';

const user = (login: string, id = login.length.toString(), avatarUrl: string | null = `https://avatars.example/${login}`): AttributedUser => ({
  id: `${id}-${login}`,
  login,
  displayName: null,
  avatarUrl,
});

const LIST_LIMITS = { compact: 2, default: 3, prominent: 5 } as const;

const octocat = user('octocat');
const many = ['octocat', 'hubot', 'monalisa', 'defunkt', 'mojombo', 'pjhyett', 'wycats'].map(login => user(login));

describe('AssigneeChip', () => {
  it('renders a decorative avatar beside @login and names the chip', () => {
    const { container } = render(<AssigneeChip user={octocat} />);

    const chip = screen.getByRole('group', { name: 'Assigned to @octocat' });
    expect(chip).toHaveTextContent('@octocat');
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', octocat.avatarUrl);
    expect(image).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to two-letter initials when the avatar fails and stays named', () => {
    const { container } = render(<AssigneeChip user={octocat} />);

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).not.toBeInTheDocument();
    const chip = screen.getByRole('group', { name: 'Assigned to @octocat' });
    expect(chip).toHaveTextContent('OC');
    expect(chip).toHaveTextContent('@octocat');
  });

  it('renders initials straight away when there is no avatar URL', () => {
    render(<AssigneeChip user={user('hubot', '2', null)} />);
    expect(screen.getByRole('group', { name: 'Assigned to @hubot' })).toHaveTextContent('HU');
  });

  it('hides the compact login below sm without changing the accessible name', () => {
    render(<AssigneeChip user={octocat} variant="compact" />);

    const chip = screen.getByRole('group', { name: 'Assigned to @octocat' });
    const login = within(chip).getByText('@octocat');
    expect(login).toHaveClass('hidden', 'sm:inline');
    expect(chip.querySelector('img')).toHaveClass('h-3.5', 'w-3.5');
  });

  it('sizes the avatar per variant', () => {
    const { container, rerender } = render(<AssigneeChip user={octocat} />);
    expect(container.querySelector('img')).toHaveClass('h-[18px]', 'w-[18px]');
    rerender(<AssigneeChip user={octocat} variant="prominent" />);
    expect(container.querySelector('img')).toHaveClass('h-6', 'w-6');
    expect(within(container).getByText('@octocat')).not.toHaveClass('hidden');
  });
});

describe('AssigneeList', () => {
  it('renders a list of named chips', () => {
    render(<AssigneeList assignees={[octocat, user('hubot')]} />);

    const list = screen.getByRole('list', { name: 'Assignees' });
    expect(within(list).getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual([
      'Assigned to @octocat',
      'Assigned to @hubot',
    ]);
    expect(list).toHaveAttribute('title', 'Assigned to @octocat, @hubot');
  });

  it.each(['compact', 'default', 'prominent'] as const)('caps the %s variant at its limit plus one +N marker', variant => {
    const limit = LIST_LIMITS[variant];
    render(<AssigneeList assignees={many} variant={variant} />);

    expect(screen.getAllByTestId('assignee-chip')).toHaveLength(limit);
    const overflow = screen.getAllByTestId('assignee-overflow');
    expect(overflow).toHaveLength(1);
    const hidden = many.slice(limit).map(({ login }) => `@${login}`).join(', ');
    expect(overflow[0]).toHaveTextContent(`+${many.length - limit}`);
    expect(overflow[0]).toHaveAttribute('title', hidden);
    expect(screen.getByRole('listitem', { name: `${many.length - limit} more assignees: ${hidden}` })).toBe(overflow[0]);
    expect(screen.getByRole('list')).toHaveAttribute('title', `Assigned to ${many.map(({ login }) => `@${login}`).join(', ')}`);
  });

  it('renders no overflow marker when everyone fits', () => {
    render(<AssigneeList assignees={many.slice(0, 3)} />);
    expect(screen.getAllByTestId('assignee-chip')).toHaveLength(3);
    expect(screen.queryByTestId('assignee-overflow')).not.toBeInTheDocument();
  });

  it('names a single hidden assignee in the singular', () => {
    render(<AssigneeList assignees={many.slice(0, 2)} max={1} />);
    expect(screen.getByRole('listitem', { name: '1 more assignee: @hubot' })).toHaveTextContent('+1');
  });

  it.each([[[]], [undefined], [null]])('renders the unassigned marker for %j', assignees => {
    render(<AssigneeList assignees={assignees} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    const marker = screen.getByTestId('assignee-unassigned');
    expect(marker).toHaveTextContent('—');
    expect(marker).toHaveTextContent('Unassigned');
  });
});

describe('AssigneeStack', () => {
  it('overlaps named avatars without logins and overflows past the stack limit', () => {
    render(<AssigneeStack assignees={many} />);

    const avatars = screen.getAllByTestId('assignee-stack-avatar');
    expect(avatars).toHaveLength(ASSIGNEE_STACK_LIMIT);
    expect(avatars[0]).toHaveAccessibleName('Assigned to @octocat');
    expect(avatars[1]).toHaveClass('-ml-1');
    expect(screen.queryByText('@octocat')).not.toBeInTheDocument();
    expect(screen.getByTestId('assignee-overflow')).toHaveTextContent(`+${many.length - ASSIGNEE_STACK_LIMIT}`);
  });

  it('renders the unassigned marker when empty', () => {
    render(<AssigneeStack assignees={[]} />);
    expect(screen.getByTestId('assignee-unassigned')).toBeInTheDocument();
  });
});

describe('UnassignedMarker', () => {
  it('shows a decorative em dash with screen-reader text', () => {
    render(<UnassignedMarker />);
    const marker = screen.getByTitle('Unassigned');
    expect(within(marker).getByText('—')).toHaveAttribute('aria-hidden', 'true');
    expect(within(marker).getByText('Unassigned')).toHaveClass('sr-only');
  });
});

describe('task assignment client', () => {
  const taskId = 'task-opencode-openai/gpt-5.6 #1';
  const encoded = encodeURIComponent(taskId);

  beforeEach(() => {
    apiClientMocks.apiFetch.mockReset();
    apiClientMocks.handleApiResponse.mockReset();
    apiClientMocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ assignees: [], users: [] })));
  });

  it('reads a task\'s assignees with the task id percent-encoded', async () => {
    await expect(getTaskAssignees(taskId)).resolves.toEqual({ assignees: [], users: [] });
    expect(apiClientMocks.apiFetch).toHaveBeenCalledWith(
      `https://api.propr.test/api/task/${encoded}/assignees`,
      { credentials: 'include' },
    );
    expect(apiClientMocks.handleApiResponse).toHaveBeenCalledOnce();
  });

  it('writes the assignees as a replace by default', async () => {
    await setTaskAssignees(taskId, ['octocat']);
    expect(apiClientMocks.apiFetch).toHaveBeenCalledWith(
      `https://api.propr.test/api/task/${encoded}/assignees`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logins: ['octocat'], mode: 'replace' }),
      },
    );

    await setTaskAssignees(taskId, ['hubot'], 'add');
    expect(JSON.parse(apiClientMocks.apiFetch.mock.calls[1][1].body)).toEqual({ logins: ['hubot'], mode: 'add' });
  });

  it('lists the assignable users with the task id percent-encoded', async () => {
    await getAssignableUsers(taskId);
    expect(apiClientMocks.apiFetch).toHaveBeenCalledWith(
      `https://api.propr.test/api/task/${encoded}/assignable-users`,
      { credentials: 'include' },
    );
  });

  it('surfaces API errors from handleApiResponse', async () => {
    apiClientMocks.handleApiResponse.mockRejectedValueOnce(new Error('forbidden'));
    await expect(setTaskAssignees(taskId, [])).rejects.toThrow('forbidden');
  });

  describe('when GitHub rejects some of the requested users', () => {
    const subject = { owner: 'integry', repo: 'propr', number: 7, kind: 'issue' as const };
    const message = 'GitHub did not assign hubot; they may not have access to integry/propr.';

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../api/apiClient')>('../api/apiClient');
      apiClientMocks.handleApiResponse.mockImplementation(actual.handleApiResponse);
    });

    const respond = (status: number, body: Record<string, unknown>) => {
      apiClientMocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }));
    };

    it('keeps the confirmed assignment and the rejected users from the 422 body', async () => {
      respond(422, {
        error: message,
        code: 'GITHUB_REJECTED',
        message,
        subject,
        assignees: [octocat],
        rejected: [user('hubot')],
      });

      const error = await setTaskAssignees(taskId, ['octocat', 'hubot']).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TaskAssigneesRejectedError);
      expect(error).toMatchObject({
        message,
        status: 422,
        code: 'GITHUB_REJECTED',
        subject,
        assignees: [octocat],
        rejected: [user('hubot')],
      });
    });

    it('keeps an ordinary error when GitHub rejected the whole request', async () => {
      respond(422, { error: 'Validation Failed', code: 'GITHUB_REJECTED', message: 'Validation Failed' });

      const error = await setTaskAssignees(taskId, ['hubot']).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(TaskAssigneesRejectedError);
      expect(error).toEqual(new Error('Validation Failed'));
    });

    it('keeps an ordinary error for other failures', async () => {
      respond(403, {
        error: 'Write access required',
        code: 'REPOSITORY_WRITE_ACCESS_REQUIRED',
        message: 'Write access required',
        subject,
        assignees: [octocat],
        rejected: [user('hubot')],
      });

      const error = await setTaskAssignees(taskId, ['hubot']).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(TaskAssigneesRejectedError);
      expect(error).toEqual(new Error('Write access required'));
    });
  });
});
