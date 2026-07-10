import DefaultTheme from 'vitepress/theme';
import Walkthrough from './components/Walkthrough.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Walkthrough', Walkthrough);
  },
};
