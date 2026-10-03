import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Echo",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="text-sm text-muted-foreground leading-relaxed flex flex-col gap-2">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 py-12 flex flex-col gap-8">
        <div>
          <Link href="/login" className="text-sm text-primary hover:underline">&larr; Back</Link>
          <h1 className="text-3xl font-bold tracking-tight mt-4">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground mt-1">Last updated: October 3, 2026</p>
        </div>

        <Section title="Overview">
          <p>
            Echo (&ldquo;the app&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is an AI-powered Gmail
            reply assistant. This policy explains what data Echo accesses, how it&apos;s used, and
            who it&apos;s shared with. Echo never sends an email without you explicitly clicking
            Send — nothing happens on your behalf automatically.
          </p>
        </Section>

        <Section title="Information We Collect">
          <p><strong className="text-foreground">Google account information</strong> — your name, email address, and profile picture, obtained via Google Sign-In.</p>
          <p><strong className="text-foreground">Gmail data</strong> — with your permission (granted via Google OAuth), Echo reads messages in your primary inbox to draft replies, and sends a reply only when you click Send. It also looks up sender contact photos via the Google Contacts API to display avatars.</p>
          <p><strong className="text-foreground">Uploaded knowledge base files</strong> — documents you choose to upload (PDF, DOCX, TXT, HTML, MD, JSON) are stored and indexed so Echo can use them as context when drafting replies.</p>
          <p><strong className="text-foreground">AI provider API keys</strong> — if you connect your own Groq, OpenAI, or Gemini API key, it is encrypted at rest (AES-256-GCM) and never returned to your browser or exposed client-side.</p>
          <p><strong className="text-foreground">Usage data</strong> — drafted replies, the reply you actually sent, which AI model was used, and any star rating or feedback you leave, so Echo can be improved over time.</p>
        </Section>

        <Section title="How We Use Your Information">
          <p>
            Your data is used solely to provide Echo&apos;s core functionality: retrieving relevant
            context from documents you&apos;ve uploaded, drafting a reply to an email using the AI
            provider you&apos;ve configured, and sending that reply only after you approve it. We do
            not use your Gmail data for advertising, profiling, or any purpose unrelated to
            drafting and sending the replies you ask for.
          </p>
        </Section>

        <Section title="How Your Data Is Shared With Third Parties">
          <p>Echo relies on a small number of third-party services to function:</p>
          <ul className="list-disc list-inside flex flex-col gap-1">
            <li><strong className="text-foreground">Your chosen AI provider</strong> (Groq, OpenAI, or Google Gemini) receives the email content and retrieved document context needed to draft a reply, sent using the API key you provided.</li>
            <li><strong className="text-foreground">Hugging Face</strong> receives email text and document excerpts to generate embeddings and rerank retrieved context — no account or identity data is sent.</li>
            <li><strong className="text-foreground">Supabase</strong> hosts our database and file storage (your knowledge base files, drafts, and settings), encrypted at rest and in transit.</li>
            <li><strong className="text-foreground">Google</strong> provides authentication and Gmail/Contacts API access, strictly within the permissions you grant.</li>
          </ul>
          <p>We do not sell your data, and we do not share it with any party beyond what&apos;s listed above.</p>
        </Section>

        <Section title="Google User Data &amp; Limited Use">
          <p>
            Echo&apos;s use and transfer of information received from Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Echo only requests the Gmail and Contacts
            scopes necessary for its described functionality — reading your primary inbox to draft
            replies, sending replies you&apos;ve approved, and looking up sender contact photos —
            and does not use this data for any other purpose.
          </p>
        </Section>

        <Section title="Data Retention &amp; Deletion">
          <p>Uploaded files and their indexed content are permanently deleted the moment you remove them from the Knowledge Base panel — nothing lingers.</p>
          <p>You can revoke Echo&apos;s access to your Google account at any time from your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google Account&apos;s security settings</a>, which immediately stops any further Gmail or Contacts access.</p>
          <p>To request deletion of your account and all associated data, contact us using the details below.</p>
        </Section>

        <Section title="Security">
          <p>API keys you provide are encrypted at rest using AES-256-GCM and are never exposed to the browser. All data in transit is encrypted via HTTPS/TLS.</p>
        </Section>

        <Section title="Changes to This Policy">
          <p>We may update this policy as Echo evolves. Material changes will be reflected by updating the &ldquo;Last updated&rdquo; date above.</p>
        </Section>

        <Section title="Contact Us">
          <p>Questions about this policy or a data deletion request can be sent to <a href="mailto:romancobblepot@gmail.com" className="text-primary hover:underline">romancobblepot@gmail.com</a>.</p>
        </Section>
      </div>
    </main>
  );
}
