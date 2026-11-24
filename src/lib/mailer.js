'use strict';
// E-mails : file d'attente persistante (table emails) + envoi SMTP via Nodemailer, avec nouvelles tentatives.
const nodemailer = require('nodemailer');
const { now, escapeHtml, euros } = require('./util');

function createTransport(cfg) {
  if (cfg.mailTransport) return cfg.mailTransport;           // injecté (tests)
  if (!cfg.smtpUrl) return null;
  return nodemailer.createTransport(cfg.smtpUrl);
}

function layout(shopName, title, bodyHtml, appUrl) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f4f7;font-family:Arial,Helvetica,sans-serif;color:#14161a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px">
<tr><td style="background:#2340e6;color:#fff;padding:18px 24px;font-size:20px;font-weight:bold;border-radius:12px 12px 0 0">${escapeHtml(shopName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#5b6070;border-top:1px solid #e6e8ee"><a href="${escapeHtml(appUrl)}" style="color:#2340e6">${escapeHtml(appUrl)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

function makeMailer(db, cfg, getSettings) {
  const transport = createTransport(cfg);

  function queue({ to, subject, text, html, kind }) {
    if (!to) return null;
    const t = now();
    const info = db.prepare(`INSERT INTO emails(to_addr, subject, text_body, html_body, kind, status, next_attempt_at, created_at)
      VALUES (?,?,?,?,?, 'queued', ?, ?)`).run(to, subject, text, html || null, kind || null, t, t);
    return info.lastInsertRowid;
  }

  // Construit un e-mail texte + HTML à partir de paragraphes et d'un lien optionnel.
  function compose(to, kind, subject, paragraphs, link) {
    const s = getSettings(db);
    const text = paragraphs.join('\n\n') + (link ? `\n\n${link.label} : ${link.url}` : '') + `\n\n— ${s.shop_name}`;
    const html = layout(s.shop_name, subject,
      paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') +
      (link ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#2340e6;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(link.label)}</a></p>` : ''),
      cfg.appUrl);
    return queue({ to, subject: `${subject} — ${s.shop_name}`, text, html, kind });
  }

  async function processQueue(limit = 20) {
    const due = db.prepare(`SELECT * FROM emails WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?`).all(now(), limit);
    for (const m of due) {
      if (!transport) {
        db.prepare(`UPDATE emails SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?`)
          .run('SMTP non configuré (variable SMTP_URL absente)', now() + 300, m.id);
        continue;
      }
      try {
        await transport.sendMail({ from: cfg.mailFrom, to: m.to_addr, subject: m.subject, text: m.text_body, html: m.html_body || undefined });
        db.prepare(`UPDATE emails SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?`).run(now(), m.id);
      } catch (e) {
        const attempts = m.attempts + 1;
        const failed = attempts >= 6;
        db.prepare(`UPDATE emails SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
          .run(failed ? 'failed' : 'queued', attempts, String(e.message).slice(0, 500), now() + 60 * 2 ** attempts, m.id);
      }
    }
  }

  // Modèles métier
  const T = {
    verify(user, url) { return compose(user.email, 'verify', 'Confirmez votre adresse e-mail', [`Bonjour ${user.name},`, 'Merci pour votre inscription. Confirmez votre adresse e-mail pour pouvoir commander. Ce lien est valable 24 heures.'], { label: 'Confirmer mon adresse', url }); },
    reset(user, url) { return compose(user.email, 'reset', 'Réinitialisation du mot de passe', [`Bonjour ${user.name},`, "Une réinitialisation de mot de passe a été demandée pour votre compte. Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."], { label: 'Choisir un nouveau mot de passe', url }); },
    orderPaid(order, items) {
      const lines = items.map((i) => `• ${i.product_name}${i.variant_name ? ' — ' + i.variant_name : ''} × ${i.qty} : ${euros(i.line_total_cents)}`).join('\n');
      return compose(order.email, 'order_paid', `Commande ${order.number} confirmée`, [
        'Merci ! Votre paiement a bien été reçu.', lines,
        `Total payé : ${euros(order.total_cents)}` + (order.shipping_method ? `\nMode de livraison : ${order.shipping_method}` : ''),
      ], { label: 'Suivre ma commande', url: `${cfg.appUrl}/#commande-${order.number}` });
    },
    orderStatus(order, label, extra) {
      return compose(order.email, 'order_status', `Commande ${order.number} : ${label}`, [
        `Le statut de votre commande est maintenant : ${label}.`, ...(extra ? [extra] : []),
      ], { label: 'Voir ma commande', url: `${cfg.appUrl}/#commande-${order.number}` });
    },
    refund(order, amount, full) {
      return compose(order.email, 'refund', `Remboursement — commande ${order.number}`, [
        `Un remboursement ${full ? 'complet' : 'partiel'} de ${euros(amount)} a été émis sur votre moyen de paiement. Le délai d'apparition dépend de votre banque.`,
      ], { label: 'Voir ma commande', url: `${cfg.appUrl}/#commande-${order.number}` });
    },
    outOfStockRefund(order) {
      return compose(order.email, 'oos_refund', `Commande ${order.number} annulée et remboursée`, [
        "Votre paiement est arrivé après l'expiration de la réservation de 15 minutes et un article n'était plus disponible. La commande a été annulée et intégralement remboursée.",
      ]);
    },
    addressChanged(order) {
      return compose(order.email, 'address', `Adresse modifiée — commande ${order.number}`, [
        `La nouvelle adresse de livraison est : ${order.ship_name}, ${order.ship_line1}${order.ship_line2 ? ', ' + order.ship_line2 : ''}, ${order.ship_postal} ${order.ship_city}.`,
      ]);
    },
    customQuoted(user, reqRow) {
      return compose(user.email, 'custom_quote', `Devis pour « ${reqRow.title} »`, [
        `Votre demande sur mesure a reçu un devis de ${euros(reqRow.quote_cents)} (délai estimé : ${reqRow.quote_days} jour(s)).`,
        ...(reqRow.quote_message ? [reqRow.quote_message] : []), 'Vous pouvez accepter et payer le devis depuis votre compte.',
      ], { label: 'Voir le devis', url: `${cfg.appUrl}/#compte` });
    },
    customRejected(user, reqRow) {
      return compose(user.email, 'custom_rejected', `Demande « ${reqRow.title} »`, ['Nous ne pouvons malheureusement pas réaliser cette demande.', ...(reqRow.quote_message ? [reqRow.quote_message] : [])]);
    },
    newsletterConfirm(email, url) { return compose(email, 'nl_confirm', 'Confirmez votre inscription à la newsletter', ['Cliquez sur le bouton pour confirmer votre inscription. Sans confirmation, vous ne recevrez aucun message.'], { label: "Confirmer l'inscription", url }); },
    premiumChanged(user, active) { return compose(user.email, 'premium', active ? 'Bienvenue dans Premium' : 'Abonnement Premium terminé', [active ? 'Votre abonnement Premium est actif. Vos avantages s’appliquent automatiquement à vos prochaines commandes.' : 'Votre abonnement Premium a pris fin.']); },
    adminNotify(subject, text) { return cfg.adminNotifyEmail ? compose(cfg.adminNotifyEmail, 'admin', subject, [text], { label: 'Ouvrir l’administration', url: `${cfg.appUrl}/admin` }) : null; },
  };

  return { queue, compose, processQueue, T, hasTransport: !!transport, layout };
}

module.exports = { makeMailer };
