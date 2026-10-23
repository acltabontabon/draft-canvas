import { DiagnosticReport } from '../../../ui/common/DiagnosticReport';
import { SettingsPage, SettingsSection } from '../../../ui/settings/layout';

export function SupportSettings() {
  return (
    <SettingsPage title="Support">
      <SettingsSection title="Diagnostic report">
        <DiagnosticReport />
      </SettingsSection>
    </SettingsPage>
  );
}
