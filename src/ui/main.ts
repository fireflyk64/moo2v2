import { mount } from 'svelte';
import App from './App.svelte';
import { FULL_TITLE } from './brand';
import './theme.css';

// index.html carries a static copy for the pre-JS flash; brand.ts is the truth
document.title = FULL_TITLE;

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
