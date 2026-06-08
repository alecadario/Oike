/* global React */
const { createContext, useContext, useState, useCallback } = React;

import {
  COMPANY_PROFILE_KEY, MESSAGE_PROMPTS_KEY, MESSAGE_PROMPT_DEFAULTS,
  AUTH_TOKEN, CURRENT_USER, CLIENT_CONFIG, TABLE_IDS,
} from '../globals.js';

export const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(CURRENT_USER);
  const [clientConfig, setClientConfig] = useState(CLIENT_CONFIG);

  const [companyProfile, setCompanyProfileState] = useState(() => {
    const defaults = {
      companyName: 'Your Company', services: 'digital transformation, AI, CX, data',
      market: 'your target market', senderName: 'Your Name', senderTitle: 'Business Consultant',
      goals: '', voiceTone: '', voiceAvoid: '', voiceExample: '',
    };
    try {
      const saved = localStorage.getItem(COMPANY_PROFILE_KEY);
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch {}
    return defaults;
  });

  const saveCompanyProfile = useCallback((profile) => {
    setCompanyProfileState(prev => {
      const next = { ...prev, ...profile };
      localStorage.setItem(COMPANY_PROFILE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const [messagePrompts, setMessagePromptsState] = useState(() => {
    try {
      const saved = localStorage.getItem(MESSAGE_PROMPTS_KEY);
      if (saved) return { ...MESSAGE_PROMPT_DEFAULTS, ...JSON.parse(saved) };
    } catch {}
    return { ...MESSAGE_PROMPT_DEFAULTS };
  });

  const saveMessagePrompts = useCallback((prompts) => {
    setMessagePromptsState(prev => {
      const next = { ...prev, ...prompts };
      localStorage.setItem(MESSAGE_PROMPTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <AppContext.Provider value={{
      user, setUser,
      clientConfig, setClientConfig,
      companyProfile, saveCompanyProfile,
      messagePrompts, saveMessagePrompts,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
