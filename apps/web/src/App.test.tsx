import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('App', () => {
  it('renders the product name as the page heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Akiba');
  });

  it('lists the colour schemes from ui-tokens', () => {
    render(<App />);
    expect(screen.getByText(/light, dark/)).toBeTruthy();
  });
});
