/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY,
} from '../globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from '../utils.js';
import StakeholderHistoryModal from './StakeholderHistoryModal.jsx';


function ContactsSection({ data, api, onLogActivity, onAddRecord, onUpdateRecord, onDeleteRecord, goToAccount }) {
  const { accounts, stakeholders, outreach, campaigns = [], sources = [] } = data;
  const [searchName, setSearchName] = useState('');
  const [searchAccount, setSearchAccount] = useState('');
  const [selectedInfluence, setSelectedInfluence] = useState('');
  const [historyStakeholder, setHistoryStakeholder] = useState(null);

  // Listen for global search navigation to open a specific contact
  useEffect(() => {
    const handler = (e) => {
      const { id, record } = e.detail || {};
      const found = record || stakeholders.find(s => s.id === id);
      if (found) setHistoryStakeholder(found);
    };
    window.addEventListener('oike:openContact', handler);
    return () => window.removeEventListener('oike:openContact', handler);
  }, [stakeholders]);
  const [selectedStakeholder, setSelectedStakeholder] = useState(null);
  const [showNewContact, setShowNewContact] = useState(false);
  const [ctxNewName, setCtxNewName] = useState('');
  const [ctxNewLast, setCtxNewLast] = useState('');
  const [ctxNewRole, setCtxNewRole] = useState('');
  const [ctxNewEmail, setCtxNewEmail] = useState('');
  const [ctxNewPhone, setCtxNewPhone] = useState('');
  const [ctxNewLinkedin, setCtxNewLinkedin] = useState('');
  const [ctxNewInfluence, setCtxNewInfluence] = useState('');
  const [ctxNewAccountId, setCtxNewAccountId] = useState('');
  const [ctxNewSource, setCtxNewSource] = useState('');
  const [ctxNewCampaign, setCtxNewCampaign] = useState('');
  const [ctxCreating, setCtxCreating] = useState(false);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [ctxNewAccountName, setCtxNewAccountName] = useState('');
  const [ctxNewAccountWebsite, setCtxNewAccountWebsite] = useState('');
  const [ctxCreatingAccount, setCtxCreatingAccount] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [filterSource, setFilterSource] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [bulkPainProgress, setBulkPainProgress] = useState(null); // {done, total} or null
  const STAKEHOLDER_STATUS_OPTIONS = ['Not Contacted', 'Contacted', 'Replied', 'Meeting Booked', 'Not Interested', 'DNC', 'Bounced', 'Left Company', 'Nurture'];
  const [showContactImport, setShowContactImport] = useState(false);
  const [contactCsvRows, setContactCsvRows] = useState([]);
  const [contactImporting, setContactImporting] = useState(false);
  const [updateDuplicates, setUpdateDuplicates] = useState(false);
  const [csvCampaignId, setCsvCampaignId] = useState(''); // campaign applied to all imported contacts
  const [contactImportResult, setContactImportResult] = useState(null);

  const isInbound = (src) => src && src.startsWith('Inbound');

  const createInlineAccount = async () => {
    if (!ctxNewAccountName.trim()) return;
    setCtxCreatingAccount(true);
    // Need real ID to link contact — must await, but skip full reload
    try {
      const a = api || new AirtableAPI();
      const fields = { 'Account Name': ctxNewAccountName.trim() };
      if (ctxNewAccountWebsite.trim()) fields['Website'] = ctxNewAccountWebsite.trim();
      if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
      if (CURRENT_USER?.role === 'cp') fields['CP Assigned'] = CURRENT_USER?.name || '';
      const record = await a.createRecord(TABLE_IDS.accounts, fields);
      if (record?.id) {
        setCtxNewAccountId(record.id);
        // Add to local state with real ID — no full reload needed
        if (onAddRecord) onAddRecord('accounts', fields, record.id);
      }
      setCtxNewAccountName(''); setCtxNewAccountWebsite('');
      setShowNewAccount(false);
    } catch (e) { console.error(e); window.__oikeToast('Failed to create account', 'error'); }
    setCtxCreatingAccount(false);
  };

  const createContact = async () => {
    if (!ctxNewName.trim() || !ctxNewAccountId) return;
    const fields = { 'Name': ctxNewName.trim(), 'Account': [ctxNewAccountId] };
    if (ctxNewLast.trim()) fields['Last name'] = ctxNewLast.trim();
    if (ctxNewRole.trim()) fields['Role'] = ctxNewRole.trim();
    if (ctxNewEmail.trim()) fields['Email'] = ctxNewEmail.trim();
    if (ctxNewPhone.trim()) fields['Phone number'] = ctxNewPhone.trim();
    if (ctxNewLinkedin.trim()) fields['LinkedIn'] = ctxNewLinkedin.trim();
    if (ctxNewInfluence) fields['Level of Influence'] = ctxNewInfluence;
    if (ctxNewSource) fields['Source'] = ctxNewSource;
    if (ctxNewCampaign) fields['Campaign'] = [ctxNewCampaign]; // linked record by ID
    if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
    if (CURRENT_USER?.role === 'cp') fields['CP Assigned'] = CURRENT_USER?.name || '';
    // Duplicate check
    const dup = findDuplicateStakeholder(fields, stakeholders);
    if (dup && !confirmDuplicateStakeholder(dup)) return;
    // Optimistic: show instantly
    if (onAddRecord) onAddRecord('stakeholders', fields);
    // Close form immediately
    setCtxNewName(''); setCtxNewLast(''); setCtxNewRole(''); setCtxNewEmail('');
    setCtxNewPhone(''); setCtxNewLinkedin(''); setCtxNewInfluence(''); setCtxNewAccountId('');
    setCtxNewSource(''); setCtxNewCampaign('');
    setShowNewContact(false);
    // API in background
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.stakeholders, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create contact', 'error'); if (onLogActivity) onLogActivity(); });
  };

  // ─── CSV IMPORT ───
  const handleContactCsv = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (result) => {
        const existingEmails = new Set(stakeholders.map(s => (F(s, 'Email') || '').toLowerCase()).filter(Boolean));
        const existingFullNames = stakeholders.map(s => ((F(s, 'Name') || '') + ' ' + (F(s, 'Last name') || '')).trim());
        const rows = result.data.map(row => {
          const norm = {};
          Object.keys(row).forEach(k => {
            const kl = k.toLowerCase().trim();
            if (kl === 'first name' || kl === 'firstname' || kl === 'name' || kl === 'nombre') norm.firstName = row[k]?.trim();
            if (kl === 'last name' || kl === 'lastname' || kl === 'apellido') norm.lastName = row[k]?.trim();
            if (kl === 'email' || kl === 'correo') norm.email = row[k]?.trim();
            if (kl === 'phone' || kl === 'telefono' || kl === 'phone number') norm.phone = row[k]?.trim();
            if (kl === 'role' || kl === 'title' || kl === 'cargo' || kl === 'job title') norm.role = row[k]?.trim();
            if (kl === 'linkedin' || kl === 'linkedin url') norm.linkedin = row[k]?.trim();
            if (kl === 'account' || kl === 'company' || kl === 'empresa') norm.accountName = row[k]?.trim();
            if (kl === 'source' || kl === 'fuente') norm.source = row[k]?.trim();
            if (kl === 'campaign' || kl === 'campaña') norm.campaign = row[k]?.trim();
            if (kl === 'country' || kl === 'pais' || kl === 'país') norm.country = row[k]?.trim();
            if (kl === 'website' || kl === 'web' || kl === 'url' || kl === 'account website' || kl === 'company website') norm.website = row[k]?.trim();
            if (kl === 'industry' || kl === 'industria' || kl === 'sector') norm.industry = row[k]?.trim();
          });
          if (!norm.firstName) return null;
          // Auto-inherit country from matched account if not set
          if (!norm.country && norm.accountName) {
            const matchedAcc = accounts.find(ac => (F(ac, 'Account Name') || '').toLowerCase() === (norm.accountName || '').toLowerCase());
            if (matchedAcc) norm.country = F(matchedAcc, 'Country') || '';
          }
          const fullName = (norm.firstName + ' ' + (norm.lastName || '')).trim();
          // Exact match
          const emailExact = norm.email && existingEmails.has(norm.email.toLowerCase());
          const nameExact = existingFullNames.some(n => n.toLowerCase() === fullName.toLowerCase());
          if (emailExact) return { ...norm, isDuplicate: true, duplicateReason: 'Email exists', isFuzzy: false, selected: false };
          if (nameExact) return { ...norm, isDuplicate: true, duplicateReason: 'Name already exists', isFuzzy: false, selected: false };
          // Fuzzy name match
          const fuzzyMatch = existingFullNames.find(n => strSimilarity(n, fullName) >= 0.78);
          if (fuzzyMatch) return { ...norm, isDuplicate: false, isFuzzy: true, fuzzyReason: `Similar to "${fuzzyMatch}"`, selected: true };
          return { ...norm, isDuplicate: false, isFuzzy: false, selected: true };
        }).filter(Boolean);
        setContactCsvRows(rows);
        setContactImportResult(null);
      }
    });
  };

  const importContacts = async () => {
    const toCreate = contactCsvRows.filter(r => r.selected && !r.isDuplicate);
    const toUpdate = updateDuplicates ? contactCsvRows.filter(r => r.isDuplicate) : [];
    if (toCreate.length === 0 && toUpdate.length === 0) return;
    setContactImporting(true);
    let created = 0, failed = 0;
    let updated = 0, updateSkipped = 0;
    let websitesAdded = 0;
    let industriesAdded = 0;
    let accountsCreated = 0;
    const createdStakeholderIds = []; // track for campaign assignment
    const a = api || new AirtableAPI();
    const toImport = toCreate; // alias for loop below (creation flow stays the same)
    // Track account-level fields we already wrote this session to avoid redundant writes
    const accountWebsiteUpdated = new Set();
    const accountIndustryUpdated = new Set();
    // Build lookup map: lowerAccountName → account record (existing + newly-created this session)
    const accountMap = new Map();
    accounts.forEach(ac => {
      const nm = (F(ac, 'Account Name') || '').toLowerCase().trim();
      if (nm) accountMap.set(nm, ac);
    });

    for (const row of toImport) {
      try {
        // Resolve or create account by name
        let matchedAcc = null;
        if (row.accountName) {
          const key = row.accountName.toLowerCase().trim();
          matchedAcc = accountMap.get(key);
          if (!matchedAcc) {
            // Account doesn't exist — create it on-the-fly
            try {
              const newAccFields = { 'Account Name': row.accountName.trim() };
              if (row.website) newAccFields['Website'] = row.website;
              if (row.industry) newAccFields['Industry'] = row.industry;
              if (row.country) newAccFields['Country'] = row.country;
              if (CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name) newAccFields['BDR Owner'] = [{ id: CURRENT_USER.id }];
              const newAcc = await a.createRecord(TABLE_IDS.accounts, newAccFields);
              if (newAcc?.id) {
                matchedAcc = { id: newAcc.id, fields: newAccFields };
                accountMap.set(key, matchedAcc);
                accountsCreated++;
                // Mark website/industry as already set (came from creation, not update)
                if (row.website) accountWebsiteUpdated.add(newAcc.id);
                if (row.industry) accountIndustryUpdated.add(newAcc.id);
              }
            } catch (accErr) {
              console.warn('[Import] account create failed for', row.accountName, accErr);
            }
          }
        }
        const fields = { 'Name': row.firstName };
        if (row.lastName) fields['Last name'] = row.lastName;
        if (row.email) fields['Email'] = row.email;
        if (row.phone) fields['Phone number'] = row.phone;
        if (row.role) fields['Role'] = row.role;
        if (row.linkedin) fields['LinkedIn'] = row.linkedin;
        if (row.source) fields['Source'] = row.source;
        // Resolve campaign: manual selector takes priority, then CSV column by name match
        // NOTE: do NOT set stakeholder's 'Campaign' field — that's the reverse link of
        // 'Stakeholders Reached' and would mark them as reached. Campaign assignment is
        // handled by updating 'Assigned Stakeholders' on the campaign record (done after loop).
        const resolvedCampaignId = csvCampaignId
          || (row.campaign ? (campaigns.find(c => (F(c,'Name')||'').toLowerCase() === row.campaign.toLowerCase())?.id || '') : '');
        const resolvedCountry = row.country || (matchedAcc ? F(matchedAcc, 'Country') : '') || '';
        if (resolvedCountry) fields['Country'] = resolvedCountry;
        if (matchedAcc) fields['Account'] = [matchedAcc.id];
        if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
        const newStk = await a.createRecord(TABLE_IDS.stakeholders, fields);
        if (newStk?.id && resolvedCampaignId) createdStakeholderIds.push(newStk.id);
        created++;
        // Fill account-level fields from CSV if account matched and fields are empty
        if (matchedAcc) {
          const accountUpdate = {};
          if (row.website && !accountWebsiteUpdated.has(matchedAcc.id) && !F(matchedAcc, 'Website')) {
            accountUpdate['Website'] = row.website;
            accountWebsiteUpdated.add(matchedAcc.id);
            websitesAdded++;
          }
          if (row.industry && !accountIndustryUpdated.has(matchedAcc.id) && !F(matchedAcc, 'Industry')) {
            accountUpdate['Industry'] = row.industry;
            accountIndustryUpdated.add(matchedAcc.id);
            industriesAdded++;
          }
          if (Object.keys(accountUpdate).length > 0) {
            try {
              await a.updateRecord(TABLE_IDS.accounts, matchedAcc.id, accountUpdate);
            } catch (wErr) {
              console.warn('[Import] account update failed for', matchedAcc.id, wErr);
              // Rollback counters if update failed
              if (accountUpdate['Website']) { accountWebsiteUpdated.delete(matchedAcc.id); websitesAdded--; }
              if (accountUpdate['Industry']) { accountIndustryUpdated.delete(matchedAcc.id); industriesAdded--; }
            }
          }
        }
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { failed++; console.error(e); }
    }
    // ── Helper: find or create an account (used by update pass) ──
    const resolveOrCreateAccount = async (row) => {
      if (!row.accountName) return null;
      const key = row.accountName.toLowerCase().trim();
      let matched = accountMap.get(key);
      if (matched) return matched;
      try {
        const newAccFields = { 'Account Name': row.accountName.trim() };
        if (row.website) newAccFields['Website'] = row.website;
        if (row.industry) newAccFields['Industry'] = row.industry;
        if (row.country) newAccFields['Country'] = row.country;
        const newAcc = await a.createRecord(TABLE_IDS.accounts, newAccFields);
        if (newAcc?.id) {
          matched = { id: newAcc.id, fields: newAccFields };
          accountMap.set(key, matched);
          accountsCreated++;
          if (row.website) accountWebsiteUpdated.add(newAcc.id);
          if (row.industry) accountIndustryUpdated.add(newAcc.id);
        }
      } catch (e) { console.warn('[resolveOrCreateAccount] failed:', e); }
      return matched;
    };

    // ── Update pass for duplicates (if enabled) ──
    for (const row of toUpdate) {
      try {
        // Find the existing stakeholder by email first, then by full name
        let existing = null;
        if (row.email) {
          existing = stakeholders.find(s => (F(s, 'Email') || '').toLowerCase() === row.email.toLowerCase());
        }
        if (!existing) {
          const fullName = ((row.firstName || '') + ' ' + (row.lastName || '')).trim().toLowerCase();
          existing = stakeholders.find(s => (((F(s, 'Name') || '') + ' ' + (F(s, 'Last name') || '')).trim().toLowerCase()) === fullName);
        }
        if (!existing) { updateSkipped++; continue; }

        // Build fields to update — ONLY fill empty fields (never overwrite existing data)
        const updates = {};
        if (row.email && !F(existing, 'Email')) updates['Email'] = row.email;
        if (row.phone && !F(existing, 'Phone number')) updates['Phone number'] = row.phone;
        if (row.role && !F(existing, 'Role')) updates['Role'] = row.role;
        if (row.linkedin && !F(existing, 'LinkedIn')) updates['LinkedIn'] = row.linkedin;
        if (row.source && !F(existing, 'Source')) updates['Source'] = row.source;
        if (row.country && !F(existing, 'Country')) updates['Country'] = row.country;

        // Account field — if stakeholder has no account and CSV provides one, link it (creating the account if needed)
        const existingAccIds = linkedIds(existing, 'Account');
        let linkedAcc = existingAccIds.length > 0 ? accounts.find(ac => ac.id === existingAccIds[0]) || accountMap.get((row.accountName || '').toLowerCase().trim()) : null;
        if (existingAccIds.length === 0 && row.accountName) {
          const resolvedAcc = await resolveOrCreateAccount(row);
          if (resolvedAcc?.id) {
            updates['Account'] = [resolvedAcc.id];
            linkedAcc = resolvedAcc;
          }
        }

        if (Object.keys(updates).length > 0) {
          await a.updateRecord(TABLE_IDS.stakeholders, existing.id, updates);
          updated++;
        } else {
          updateSkipped++;
        }

        // Also update the linked account's Website/Industry if empty (same logic as creation)
        if (linkedAcc) {
          const accUpdate = {};
          if (row.website && !accountWebsiteUpdated.has(linkedAcc.id) && !F(linkedAcc, 'Website')) {
            accUpdate['Website'] = row.website;
            accountWebsiteUpdated.add(linkedAcc.id);
            websitesAdded++;
          }
          if (row.industry && !accountIndustryUpdated.has(linkedAcc.id) && !F(linkedAcc, 'Industry')) {
            accUpdate['Industry'] = row.industry;
            accountIndustryUpdated.add(linkedAcc.id);
            industriesAdded++;
          }
          if (Object.keys(accUpdate).length > 0) {
            try { await a.updateRecord(TABLE_IDS.accounts, linkedAcc.id, accUpdate); } catch {}
          }
        }
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { failed++; console.error('[Update duplicate]', e); }
    }

    // Add all newly-created contacts to the campaign's Assigned Stakeholders
    if (createdStakeholderIds.length > 0 && csvCampaignId) {
      try {
        const campaignRec = campaigns.find(c => c.id === csvCampaignId);
        const currentAssigned = campaignRec ? linkedIds(campaignRec, 'Assigned Stakeholders') : [];
        const newAssigned = [...new Set([...currentAssigned, ...createdStakeholderIds])];
        await a.updateRecord(TABLE_IDS.campaigns, csvCampaignId, { 'Assigned Stakeholders': newAssigned });
      } catch (e) { console.warn('[Import] campaign assignment failed:', e); }
    }

    setContactImportResult({ created, failed, updated, updateSkipped, websitesAdded, industriesAdded, accountsCreated });
    setContactImporting(false);
    if (onLogActivity) onLogActivity();
  };

  const useMessage = (stakeholder, channel, message, ccList = [], eventId = null) => {
    const name = F(stakeholder, 'Name') || '';
    const email = F(stakeholder, 'Email') || '';
    const phone = F(stakeholder, 'Phone number') || '';
    const linkedin = F(stakeholder, 'LinkedIn') || '';
    let subject = '', body = message;
    if (channel === 'Email') {
      const lines = message.split('\n');
      const subjectIdx = lines.findIndex(l => /^subject:/i.test(l.trim()));
      if (subjectIdx !== -1) {
        subject = lines[subjectIdx].replace(/^subject:\s*/i, '').trim();
        body = lines.slice(subjectIdx + 1).join('\n').trim();
      }
    }
    if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    else if (channel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
    const companyIds = linkedIds(stakeholder, 'Account');
    const outreachFields = {
      'Activity Name': `${channel} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
      'Account': companyIds, 'Stakeholder': [stakeholder.id],
      'Channel': channel, 'Date': new Date().toISOString(),
      'Status': 'Sent', 'Message': message,
      'Notes': 'Sent from Contacts',
      'Logged By': CURRENT_USER?.name || '',
      ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
      ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
    };
    if (onAddRecord) onAddRecord('outreach', outreachFields);
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.outreach, outreachFields)
      .then(async () => {
        if (eventId) {
          const ev = data.events?.find(e => e.id === eventId);
          const currentInvited = ev ? linkedIds(ev, 'Stakeholders invited') : [];
          await a.updateRecord(TABLE_IDS.events, eventId, {
            'Stakeholders invited': [...new Set([...currentInvited, stakeholder.id])],
          }).catch(e => console.error('[useMessage] event invite update failed:', e));
        }
        await activateAccountIfNeeded(a, companyIds, data.accounts);
        await updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders);
      })
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => console.error(e));
  };

  const deleteContact = async (s) => {
    const name = `${F(s, 'Name') || ''} ${F(s, 'Last name') || ''}`.trim() || 'this contact';
    if (!confirm(`Delete ${name}?\n\nThis removes the contact and their link to the account permanently. Outreach history attached to this contact will stay in the Outreach Log but will no longer resolve to a name.`)) return;
    try {
      const a = api || new AirtableAPI();
      await a.deleteRecord(TABLE_IDS.stakeholders, s.id);
      if (onDeleteRecord) onDeleteRecord('stakeholders', s.id);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[deleteContact] failed:', e);
      window.__oikeToast('Failed to delete: ' + (e.message || 'unknown'), 'error');
    }
  };

  const saveContactEdit = async (values) => {
    if (!editingContact) return;
    // Only send fields that have a value — Airtable rejects empty strings for Email, Phone, URL, and Single Select fields
    const raw = {
      'Name': values['Name'],
      'Last name': values['Last name'],
      'Role': values['Role'],
      'Email': values['Email'],
      'Phone number': values['Phone number'],
      'LinkedIn': values['LinkedIn'],
      'Campaign': values['Campaign'] ? [values['Campaign']] : null, // linked record by ID
      'Country': values['Country'] || null,
      'Level of Influence': values['Level of Influence'] || null,
      'Source': values['Source'] || null,
    };
    const updatedFields = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    if (onUpdateRecord) onUpdateRecord('stakeholders', editingContact.id, updatedFields);
    setEditingContact(null);
    const a = api || new AirtableAPI();
    a.updateRecord(TABLE_IDS.stakeholders, editingContact.id, updatedFields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to save contact: ' + (e.message || 'Unknown error'), 'error'); if (onLogActivity) onLogActivity(); });
  };

  const influenceLevels = useMemo(() => {
    const levels = new Set();
    stakeholders.forEach(s => { const l = F(s, 'Level of Influence'); if (l) levels.add(l); });
    return [...levels].sort();
  }, [stakeholders]);

  const filtered = useMemo(() => stakeholders.filter(s => {
    if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return false;
    if (searchAccount) {
      const term = searchAccount.toLowerCase();
      const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
      if (!accNames.some(n => n.toLowerCase().includes(term))) return false;
    }
    if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return false;
    if (filterSource && F(s, 'Source') !== filterSource) return false;
    if (filterCountry && (F(s, 'Country') || '').toLowerCase() !== filterCountry.toLowerCase()) return false;
    if (filterStatus) {
      const sStatus = F(s, 'Status') || 'Not Contacted';
      if (sStatus !== filterStatus) return false;
    }
    return true;
  }).sort((a, b) => (F(a, 'Name') || '').localeCompare(F(b, 'Name') || '')), [stakeholders, searchName, searchAccount, selectedInfluence, filterSource, filterStatus, filterCountry, accounts]);

  const bulkGeneratePains = async (targets) => {
    if (bulkPainProgress) return;
    const pending = targets.filter(s => !(F(s,'Pain Points (Generated)') || '').trim());
    if (pending.length === 0) { window.__oikeToast('Todos los contactos filtrados ya tienen pains generados.', 'warning'); return; }
    setBulkPainProgress({ done: 0, total: pending.length });
    const a = api || new AirtableAPI();
    for (let i = 0; i < pending.length; i++) {
      const s = pending[i];
      const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
      const role = F(s,'Role') || '';
      const accId = linkedIds(s,'Account')[0];
      const acc = accId ? accounts.find(ac => ac.id === accId) : null;
      const accName = acc ? F(acc,'Account Name') : '';
      const industry = acc ? F(acc,'Industry') : '';
      const news = acc ? (F(acc,'Recent News')||'').slice(0,300) : '';
      try {
        const prompt = `B2B sales analyst. Generate 3-5 specific pain points for this stakeholder.
PERSON: ${sName} | ${role}
COMPANY: ${accName}${industry ? ` | ${industry}` : ''}
${news ? `COMPANY NEWS: ${news}` : ''}
SELLER: ${COMPANY_PROFILE.companyName} — ${COMPANY_PROFILE.services}

Pain points must be specific to their role, reference industry challenges, and connect to where ${COMPANY_PROFILE.companyName} can help. Bullet points, 1-2 sentences each. Write ONLY the pain points.`;
        const result = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 350 });
        await a.updateRecord(TABLE_IDS.stakeholders, s.id, { 'Pain Points (Generated)': result });
        if (onUpdateRecord) onUpdateRecord('stakeholders', s.id, { 'Pain Points (Generated)': result });
      } catch(e) { console.error('Pain gen failed for', sName, e); }
      setBulkPainProgress({ done: i + 1, total: pending.length });
      if (i < pending.length - 1) await new Promise(r => setTimeout(r, 800));
    }
    setBulkPainProgress(null);
    if (onLogActivity) onLogActivity();
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Contacts</h1>
          <p>All stakeholders · {stakeholders.length} total</p>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setShowContactImport(!showContactImport); setContactImportResult(null); }}>
            {showContactImport ? '✕ Close Import' : '📥 Import CSV'}
          </button>
          <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => bulkGeneratePains(filtered)} disabled={!!bulkPainProgress}>
            {bulkPainProgress ? `⏳ ${bulkPainProgress.done}/${bulkPainProgress.total} pains...` : '✨ Generate Pains'}
          </button>
          <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowNewContact(!showNewContact)}>
            {showNewContact ? '✕ Close' : '➕ New Contact'}
          </button>
        </div>
      </div>

      <div className="filters-row">
        <input className="input-field" style={{ maxWidth: 220 }} placeholder="Search by name..." value={searchName} onChange={e => setSearchName(e.target.value)} />
        <input className="input-field" style={{ maxWidth: 220 }} placeholder="Filter by account..." value={searchAccount} onChange={e => setSearchAccount(e.target.value)} />
        <select className="input-field" style={{ maxWidth: 200 }} value={selectedInfluence} onChange={e => setSelectedInfluence(e.target.value)}>
          <option value="">All Influence Levels</option>
          {influenceLevels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select className="input-field" style={{ maxWidth: 200 }} value={filterSource} onChange={e => setFilterSource(e.target.value)}>
          <option value="">All Sources</option>
          {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input-field" style={{ maxWidth: 200 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {STAKEHOLDER_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input-field" style={{ maxWidth: 180 }} value={filterCountry} onChange={e => setFilterCountry(e.target.value)}>
          <option value="">All Countries</option>
          {[...new Set(stakeholders.map(s => F(s,'Country')).filter(Boolean))].sort().map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* New Contact Form */}
      {showNewContact && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
          <div className="card-header"><h3>➕ New Contact</h3></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>FIRST NAME *<InfoTip text="Contact's first name as it appears on LinkedIn or their email signature." /></label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Khalid" value={ctxNewName} onChange={e => setCtxNewName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LAST NAME<InfoTip text="Contact's last name." /></label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Al-Rashid" value={ctxNewLast} onChange={e => setCtxNewLast(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ACCOUNT *<InfoTip text="The company this contact works at. Select existing or create a new one inline." /></label>
              {!showNewAccount ? (
                <div style={{ display: 'flex', gap: 4 }}>
                  <select className="input-field" style={{ flex: 1, fontSize: 12, padding: '6px 8px' }} value={ctxNewAccountId} onChange={e => setCtxNewAccountId(e.target.value)}>
                    <option value="">Select account...</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
                  </select>
                  {CURRENT_USER?.role === 'admin' && <button onClick={() => setShowNewAccount(true)} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--globant-green)', background: 'rgba(91,191,181,0.1)', color: 'var(--globant-green)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ New</button>}
                </div>
              ) : (
                <div style={{ padding: '8px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, border: '1px solid rgba(91,191,181,0.2)' }}>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '5px 8px', marginBottom: 4 }} placeholder="Company name *" value={ctxNewAccountName} onChange={e => setCtxNewAccountName(e.target.value)} />
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '5px 8px', marginBottom: 6 }} placeholder="Website (optional)" value={ctxNewAccountWebsite} onChange={e => setCtxNewAccountWebsite(e.target.value)} />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="action-btn btn-primary" style={{ fontSize: 10, flex: 1 }} onClick={createInlineAccount} disabled={!ctxNewAccountName.trim() || ctxCreatingAccount}>{ctxCreatingAccount ? '⏳' : '✓ Create Account'}</button>
                    <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => { setShowNewAccount(false); setCtxNewAccountName(''); setCtxNewAccountWebsite(''); }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ROLE<InfoTip text="Their job title. E.g. 'VP Sales', 'CTO', 'CEO'. Used in AI-generated messaging." /></label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. CTO" value={ctxNewRole} onChange={e => setCtxNewRole(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EMAIL<InfoTip text="Business email for outreach. Used for email sequences and personalization." /></label>
              <input className="input-field" type="email" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="email@company.com" value={ctxNewEmail} onChange={e => setCtxNewEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>PHONE<InfoTip text="Mobile or office number for WhatsApp or call outreach." /></label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="+971..." value={ctxNewPhone} onChange={e => setCtxNewPhone(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LINKEDIN URL<InfoTip text="Full LinkedIn profile URL. Used for research and personalizing outreach." /></label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="https://linkedin.com/in/..." value={ctxNewLinkedin} onChange={e => setCtxNewLinkedin(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>INFLUENCE<InfoTip text="How much power this person has in a buying decision. Decision Maker = final say. Champion = internal advocate. Influencer = shapes opinion." /></label>
              <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={ctxNewInfluence} onChange={e => setCtxNewInfluence(e.target.value)}>
                <option value="">Select...</option>
                <option value="Decision Maker">Decision Maker</option>
                <option value="High">High</option>
                <option value="Influencer">Influencer</option>
                <option value="Champion">Champion</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>SOURCE<InfoTip text="How did you find or meet this contact? Helps track which channels generate the most pipeline." /></label>
              <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={ctxNewSource} onChange={e => setCtxNewSource(e.target.value)}>
                <option value="">Select source...</option>
                {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>CAMPAIGN<InfoTip text="Link this contact to an existing campaign. Create the campaign first in the Campaigns section." /></label>
              <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={ctxNewCampaign} onChange={e => setCtxNewCampaign(e.target.value)}>
                <option value="">No campaign</option>
                {campaigns.sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||'')).map(c => (
                  <option key={c.id} value={c.id}>{F(c,'Name')}{F(c,'Status') ? ` (${F(c,'Status')})` : ''}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={createContact} disabled={!ctxNewName.trim() || !ctxNewAccountId || ctxCreating}>
              {ctxCreating ? '⏳ Creating...' : '🚀 Create Contact'}
            </button>
            <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowNewContact(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* CSV Import Card */}
      {showContactImport && (
        <div className="card" style={{ borderLeft: '3px solid #7c3aed', marginBottom: 16 }}>
          <div className="card-header">
            <h3>📥 Import Contacts from CSV</h3>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Supported columns: First Name, Last Name, Email, Phone, Role, LinkedIn, Account, Website, Industry, Country, Source, Campaign</span>
          </div>
          {!contactCsvRows.length ? (
            <div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                  Assign to Campaign <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional — applies to all imported contacts)</span>
                </label>
                <select className="input-field" style={{ fontSize: 12, padding: '6px 8px', minWidth: 260 }} value={csvCampaignId} onChange={e => setCsvCampaignId(e.target.value)}>
                  <option value="">No campaign</option>
                  {campaigns.sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||'')).map(c => (
                    <option key={c.id} value={c.id}>{F(c,'Name')}{F(c,'Status') ? ` (${F(c,'Status')})` : ''}</option>
                  ))}
                </select>
              </div>
              <input type="file" accept=".csv" onChange={handleContactCsv} style={{ fontSize: 12, color: 'var(--globant-muted)' }} />
              <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 8 }}>
                Tip: Column headers must match exactly (case-insensitive). Country is auto-inherited from the account if not specified. Duplicates by email or full name are auto-detected. You can also include a "Campaign" column in the CSV to assign per-row.
              </p>
            </div>
          ) : (
            <div>
              {contactImportResult ? (
                <div style={{ padding: '12px', background: 'rgba(91,191,181,0.08)', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
                  ✅ Import complete — <strong>{contactImportResult.created}</strong> created{contactImportResult.updated > 0 ? `, 🔄 ${contactImportResult.updated} updated` : ''}{contactImportResult.updateSkipped > 0 ? ` (${contactImportResult.updateSkipped} already complete)` : ''}{contactImportResult.failed > 0 ? `, ❌ ${contactImportResult.failed} failed` : ''}{contactImportResult.accountsCreated > 0 ? ` · 🏢 ${contactImportResult.accountsCreated} new account${contactImportResult.accountsCreated !== 1 ? 's' : ''}` : ''}{contactImportResult.websitesAdded > 0 ? ` · 🌐 ${contactImportResult.websitesAdded} website${contactImportResult.websitesAdded !== 1 ? 's' : ''}` : ''}{contactImportResult.industriesAdded > 0 ? ` · 🏭 ${contactImportResult.industriesAdded} industr${contactImportResult.industriesAdded !== 1 ? 'ies' : 'y'}` : ''}.
                  <button className="action-btn btn-ghost" style={{ fontSize: 11, marginLeft: 12 }} onClick={() => { setContactCsvRows([]); setContactImportResult(null); }}>Import another</button>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--globant-muted)' }}>
                    {contactCsvRows.length} rows parsed · <span style={{ color: '#ef4444' }}>{contactCsvRows.filter(r => r.isDuplicate).length} exact duplicates</span>{contactCsvRows.filter(r => r.isFuzzy).length > 0 && <> · <span style={{ color: '#f59e0b' }}>{contactCsvRows.filter(r => r.isFuzzy).length} possible duplicates</span></>} · <span style={{ color: 'var(--globant-green)' }}>{contactCsvRows.filter(r => r.selected && !r.isDuplicate).length} to import</span>
                  </div>
                  <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                    <table className="data-table" style={{ fontSize: 11 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}>
                            <input type="checkbox" checked={contactCsvRows.every(r => r.isDuplicate || r.selected)} onChange={e => setContactCsvRows(rows => rows.map(r => r.isDuplicate ? r : { ...r, selected: e.target.checked }))} />
                          </th>
                          <th>Name</th><th>Account</th><th>Email</th><th>Country</th><th>Source</th><th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contactCsvRows.map((row, i) => (
                          <tr key={i} style={{ opacity: row.isDuplicate ? 0.45 : 1, background: row.isFuzzy ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                            <td><input type="checkbox" checked={row.selected && !row.isDuplicate} disabled={row.isDuplicate} onChange={e => setContactCsvRows(rows => rows.map((r, j) => j === i ? { ...r, selected: e.target.checked } : r))} /></td>
                            <td>{row.firstName} {row.lastName}</td>
                            <td>{row.accountName || '—'}</td>
                            <td>{row.email || '—'}</td>
                            <td style={{ fontSize: 11 }}>{row.country ? <span style={{ color: 'var(--globant-muted)' }}>{row.country}</span> : <span style={{ color: 'rgba(255,255,255,0.2)' }}>—</span>}</td>
                            <td>{row.source || '—'}</td>
                            <td>
                              {row.isDuplicate
                                ? <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: 9 }}>🚫 {row.duplicateReason}</span>
                                : row.isFuzzy
                                ? <span className="badge" style={{ background: 'rgba(251,191,36,0.15)', color: '#f59e0b', fontSize: 9 }} title={row.fuzzyReason}>⚠️ {row.fuzzyReason}</span>
                                : <span className="badge badge-green" style={{ fontSize: 9 }}>✓ New</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--globant-text)' }}>
                      <input type="checkbox" checked={updateDuplicates} onChange={e => setUpdateDuplicates(e.target.checked)} style={{ cursor: 'pointer' }} />
                      <span>🔄 Update duplicates with new info <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>(fills empty fields only, never overwrites)</span></span>
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    {(() => {
                      const toCreate = contactCsvRows.filter(r => r.selected && !r.isDuplicate).length;
                      const toUpdate = updateDuplicates ? contactCsvRows.filter(r => r.isDuplicate).length : 0;
                      const total = toCreate + toUpdate;
                      const label = toUpdate > 0
                        ? `🚀 Import (${toCreate} new${toUpdate > 0 ? ` + ${toUpdate} updates` : ''})`
                        : `🚀 Import ${toCreate} contacts`;
                      return (
                        <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={importContacts} disabled={contactImporting || total === 0}>
                          {contactImporting ? '⏳ Importing...' : label}
                        </button>
                      );
                    })()}
                    <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setContactCsvRows([]); setContactImportResult(null); }}>↩ Re-upload</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Contacts Table */}
      <div className="card">
        <div className="card-header">
          <h3>👤 All Contacts ({filtered.length})</h3>
          {(searchName || searchAccount || selectedInfluence) && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Filtered from {stakeholders.length} total</span>}
        </div>
        {filtered.length === 0 ? (
          <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '12px 0' }}>No contacts found. {stakeholders.length === 0 ? 'Add your first contact above.' : 'Try clearing your filters.'}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Account</th>
                <th>Status</th>
                <th>Influence</th>
                <th>Source</th>
                <th style={{ textAlign: 'center' }}>Touches</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                const phone = F(s, 'Phone number');
                const email = F(s, 'Email');
                const linkedin = F(s, 'LinkedIn');
                const touches = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id)).length;
                const fallback = `Hi ${F(s, 'Name')}, reaching out from ${COMPANY_PROFILE.companyName} regarding potential collaboration.`;
                return (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>
                        {F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s, 'Role')}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{accNames.join(', ')}</td>
                    <td>{(() => {
                      const status = F(s, 'Status') || 'Not Contacted';
                      const colors = {
                        'Not Contacted': { bg: 'rgba(136,136,168,0.15)', fg: '#8888a8' },
                        'Contacted':     { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24' },
                        'Replied':       { bg: 'rgba(74,222,128,0.15)', fg: '#4ade80' },
                        'Meeting Booked':{ bg: 'rgba(96,165,250,0.15)', fg: '#60a5fa' },
                        'Not Interested':{ bg: 'rgba(249,115,22,0.15)', fg: '#f97316' },
                        'DNC':           { bg: 'rgba(239,68,68,0.20)',  fg: '#ef4444' },
                        'Bounced':       { bg: 'rgba(234,88,12,0.15)',  fg: '#ea580c' },
                        'Left Company':  { bg: 'rgba(156,163,175,0.15)',fg: '#9ca3af' },
                        'Nurture':       { bg: 'rgba(167,139,250,0.15)',fg: '#a78bfa' },
                      }[status] || { bg: 'rgba(136,136,168,0.15)', fg: '#8888a8' };
                      return <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: colors.bg, color: colors.fg, fontWeight: 700, whiteSpace: 'nowrap' }}>{status}</span>;
                    })()}</td>
                    <td><span className="badge badge-accent">{F(s, 'Level of Influence') || '—'}</span></td>
                    <td>{(() => {
                      const rawSrc = s.fields?.['Source'];
                      const srcIds = Array.isArray(rawSrc) ? rawSrc : (rawSrc && String(rawSrc).startsWith('rec') ? [rawSrc] : []);
                      const srcRec = srcIds.length ? sources.find(r => r.id === srcIds[0]) : null;
                      const srcName = srcRec ? (F(srcRec,'Source Name') || F(srcRec,'Source') || srcIds[0]) : (typeof rawSrc === 'string' && rawSrc && !rawSrc.startsWith('rec') ? rawSrc : null);
                      const rawCamp = s.fields?.['Campaign'];
                      const campIds = Array.isArray(rawCamp) ? rawCamp : (rawCamp && String(rawCamp).startsWith('rec') ? [rawCamp] : []);
                      const campRec = campIds.length ? campaigns.find(c => c.id === campIds[0]) : null;
                      const campName = campRec ? F(campRec,'Name') : (typeof rawCamp === 'string' && rawCamp && !rawCamp.startsWith('rec') ? rawCamp : null);
                      return (<>
                        {srcName ? (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: isInbound(srcName) ? 'rgba(124,58,237,0.15)' : 'rgba(91,191,181,0.15)', color: isInbound(srcName) ? '#a78bfa' : 'var(--globant-green)', whiteSpace: 'nowrap' }}>{srcName}</span>
                        ) : <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>—</span>}
                        {campName && <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 2 }}>{campName}</div>}
                      </>);
                    })()}</td>
                    <td style={{ textAlign: 'center', fontSize: 13 }}>
                      {touches > 0 ? <span style={{ color: 'var(--globant-green)', fontWeight: 700 }}>{touches}</span> : <span style={{ color: 'var(--globant-muted)' }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setSelectedStakeholder(s)}>✨</button>
                        {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '4px 8px' }} title="WhatsApp" onClick={() => useMessage(s, 'WhatsApp', fallback)}>💬</button>}
                        {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '4px 8px' }} title="Email" onClick={() => useMessage(s, 'Email', fallback)}>✉️</button>}
                        {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '4px 8px' }} title="LinkedIn" onClick={() => useMessage(s, 'LinkedIn', fallback)}>🔗</button>}
                        {phone && <button className="action-btn btn-call" style={{ fontSize: 11, padding: '4px 8px' }} title="Call" onClick={() => useMessage(s, 'Call', fallback)}>📞</button>}
                        <button title="Edit contact" style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--globant-border)', background: 'rgba(255,255,255,0.04)', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => setEditingContact(s)}>✏️</button>
                        <button title="Delete contact" style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(229,115,115,0.3)', background: 'rgba(229,115,115,0.08)', color: '#e57373', cursor: 'pointer' }} onClick={() => deleteContact(s)}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedStakeholder && (
        <AIMessageModal stakeholder={selectedStakeholder} onClose={() => setSelectedStakeholder(null)} onSend={useMessage} onSuccess={() => { setSelectedStakeholder(null); if (onLogActivity) onLogActivity(); }} data={data} />
      )}
      {historyStakeholder && (
        <StakeholderHistoryModal
          stakeholder={historyStakeholder}
          outreach={outreach}
          accounts={accounts}
          onClose={() => setHistoryStakeholder(null)}
          onRefresh={onLogActivity}
          onAddRecord={onAddRecord}
          allData={data}
          onNavigateToAccount={goToAccount}
          onSend={useMessage}
        />
      )}
      {editingContact && (() => {
        const currentCampaignId = (editingContact.fields?.['Campaign'] || [])[0] || '';
        const campaignOptions = [{ value: '', label: 'No campaign' },
          ...campaigns.sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||'')).map(c => ({ value: c.id, label: `${F(c,'Name')}${F(c,'Status') ? ` (${F(c,'Status')})` : ''}` }))
        ];
        return (
          <EditModal
            title={`${F(editingContact, 'Name')} ${F(editingContact, 'Last name') || ''}`.trim()}
            fields={[
              { key: 'Name', label: 'First Name' },
              { key: 'Last name', label: 'Last Name' },
              { key: 'Role', label: 'Role / Title' },
              { key: 'Email', label: 'Email' },
              { key: 'Phone number', label: 'Phone' },
              { key: 'LinkedIn', label: 'LinkedIn URL' },
              { key: 'Level of Influence', label: 'Influence', type: 'select', options: ['Decision Maker', 'High', 'Influencer', 'Champion', 'Medium', 'Low'] },
              { key: 'Country', label: 'Country' },
              { key: 'Source', label: 'Source', type: 'select', options: SOURCE_OPTIONS },
              { key: 'Campaign', label: 'Campaign', type: 'select', options: campaignOptions },
            ]}
            initialValues={{ ...(editingContact.fields || {}), Campaign: currentCampaignId }}
            onSave={saveContactEdit}
            onClose={() => setEditingContact(null)}
          />
        );
      })()}
    </div>
  );
}

// ============ ACTIVITY TRACKER ============

export default ContactsSection;
