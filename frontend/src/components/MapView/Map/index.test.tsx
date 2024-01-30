import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import React from 'react';
import { store } from 'context/store';
import MapComponent from '.';

jest.mock('react-router-dom', () => ({
  useHistory: () => ({
    replace: jest.fn(),
    location: {
      search: '',
    },
  }),
}));

test('renders as expected', () => {
  const { container } = render(
    <Provider store={store}>
      <MapComponent setIsAlertFormOpen={() => {}} panelHidden={false} />
    </Provider>,
  );
  expect(container).toMatchSnapshot();
});
