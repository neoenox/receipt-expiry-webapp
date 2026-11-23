import { buildCalendar } from './features2.js';

export function createCalendarUI({ ui, state }) {
  function render() {
    const days = buildCalendar(state.items, state.calendarYear, state.calendarMonth);
    const firstDay = new Date(state.calendarYear, state.calendarMonth, 1).getDay();
    const dayCount = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    const header = document.createElement('div');
    header.className = 'calendar-header';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.dataset.calendar = 'prev';
    prev.textContent = '‹';
    const label = document.createElement('strong');
    label.textContent = `${state.calendarYear}年 ${state.calendarMonth + 1}月`;
    const next = document.createElement('button');
    next.type = 'button';
    next.dataset.calendar = 'next';
    next.textContent = '›';
    header.append(prev, label, next);

    for (let i = 0; i < firstDay; i += 1) {
      const empty = document.createElement('div');
      empty.className = 'calendar-cell is-empty';
      grid.append(empty);
    }
    for (let day = 1; day <= dayCount; day += 1) {
      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      const number = document.createElement('div');
      number.className = 'calendar-day';
      number.textContent = String(day);
      cell.append(number);
      for (const item of days.get(day) || []) {
        const name = document.createElement('div');
        name.className = 'calendar-item';
        name.textContent = item.name;
        cell.append(name);
      }
      grid.append(cell);
    }
    ui.calendarView.replaceChildren(header, grid);
  }

  function toggle() {
    const showingCalendar = !ui.calendarView.classList.contains('hidden');
    if (showingCalendar) {
      ui.calendarView.classList.add('hidden');
      ui.list.classList.remove('hidden');
      ui.emptyState.classList.toggle('hidden', state.items.length > 0);
      ui.viewToggle.textContent = 'カレンダー';
    } else {
      render();
      ui.calendarView.classList.remove('hidden');
      ui.list.classList.add('hidden');
      ui.emptyState.classList.add('hidden');
      ui.viewToggle.textContent = '一覧';
    }
  }

  function shiftMonth(direction) {
    if (direction === 'prev') state.calendarMonth -= 1;
    else state.calendarMonth += 1;
    if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear -= 1; }
    if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear += 1; }
    render();
  }

  return { render, toggle, shiftMonth };
}
