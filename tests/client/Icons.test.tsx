// =============================================================================
// Fleet Commander — Icons Smoke Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  LayoutGridIcon,
  GitBranchIcon,
  BarChart3Icon,
  FolderGit2Icon,
  RocketIcon,
  PlayIcon,
  SquareIcon,
  CircleStopIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  AlertTriangleIcon,
  SettingsIcon,
  XCircleIcon,
  RefreshCwIcon,
  DollarSignIcon,
  ActivityIcon,
  CircleDotIcon,
  ZapIcon,
  UserIcon,
  ClockIcon,
  PencilIcon,
  MoreHorizontalIcon,
  LockIcon,
  ChevronRightIcon,
} from '../../src/client/components/Icons';

// ---------------------------------------------------------------------------
// Tests — each icon renders an SVG without crashing
// ---------------------------------------------------------------------------

const icons = [
  { name: 'LayoutGridIcon', Component: LayoutGridIcon },
  { name: 'GitBranchIcon', Component: GitBranchIcon },
  { name: 'BarChart3Icon', Component: BarChart3Icon },
  { name: 'FolderGit2Icon', Component: FolderGit2Icon },
  { name: 'RocketIcon', Component: RocketIcon },
  { name: 'PlayIcon', Component: PlayIcon },
  { name: 'SquareIcon', Component: SquareIcon },
  { name: 'CircleStopIcon', Component: CircleStopIcon },
  { name: 'ArrowRightIcon', Component: ArrowRightIcon },
  { name: 'ArrowLeftIcon', Component: ArrowLeftIcon },
  { name: 'AlertTriangleIcon', Component: AlertTriangleIcon },
  { name: 'SettingsIcon', Component: SettingsIcon },
  { name: 'XCircleIcon', Component: XCircleIcon },
  { name: 'RefreshCwIcon', Component: RefreshCwIcon },
  { name: 'DollarSignIcon', Component: DollarSignIcon },
  { name: 'ActivityIcon', Component: ActivityIcon },
  { name: 'CircleDotIcon', Component: CircleDotIcon },
  { name: 'ZapIcon', Component: ZapIcon },
  { name: 'UserIcon', Component: UserIcon },
  { name: 'ClockIcon', Component: ClockIcon },
  { name: 'PencilIcon', Component: PencilIcon },
  { name: 'MoreHorizontalIcon', Component: MoreHorizontalIcon },
  { name: 'LockIcon', Component: LockIcon },
  { name: 'ChevronRightIcon', Component: ChevronRightIcon },
];

describe('Icons', () => {
  icons.forEach(({ name, Component }) => {
    it(`${name} renders an SVG element`, () => {
      const { container } = render(<Component />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  it('respects custom size prop', () => {
    const { container } = render(<LayoutGridIcon size={32} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });

  it('respects custom className prop', () => {
    const { container } = render(<LayoutGridIcon className="my-custom-class" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('my-custom-class');
  });

  it('uses default size when no size prop is given', () => {
    const { container } = render(<LayoutGridIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
  });
});
