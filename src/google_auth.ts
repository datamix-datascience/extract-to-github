import * as core from '@actions/core';
import { GoogleAuth } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';

export async function get_google_auth(): Promise<{ auth: GoogleAuth<any>; drive: drive_v3.Drive } | null> {
  try {
    const credentials_json_string = core.getInput('google_service_account_key', { required: true });
    if (!credentials_json_string) {
      core.setFailed('Google Service Account Key JSON was not provided.');
      return null;
    }

    const credentials = JSON.parse(credentials_json_string);

    const auth = new GoogleAuth({
      credentials,
      // Still only need read access to download/export
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const drive = google.drive({ version: 'v3', auth });
    core.info('Google Drive API client authenticated successfully.');
    return { auth, drive };
  } catch (error: any) {
    core.setFailed(`Google authentication failed: ${error.message}`);
    return null;
  }
}
