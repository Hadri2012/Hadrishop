'use strict';
// E-mails : file d'attente Firestore (collection emails) + envoi SMTP Nodemailer avec nouvelles tentatives.
const nodemailer = require('nodemailer');
const { now, escapeHtml, euros } = require('./util');

function layout(shopName, title, bodyHtml, appUrl) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f4f7;font-family:Arial,Helvetica,sans-serif;color:#14161a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px">
<tr><td style="background:#2340e6;color:#fff;padding:18px 24px;font-size:20px;font-weight:bold;border-radius:12px 12px 0 0">${escapeHtml(shopName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#5b6070;border-top:1px solid #e6e8ee"><a href="${escapeHtml(appUrl)}" style="color:#2340e6">${escapeHtml(appUrl)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

function makeMailer(db, cfg, settings) {
  const transport = cfg.mailTransport || (cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null);
  const col = db.collection('emails');

  async function queue({ to, subject, text, html, kind }) {
    if (!to) return null;
    const t = now();
    const ref = await col.add({ to, subject, text, html: html || null, kind: kind || null, status: 'queued', attempts: 0, lastError: null, nextAttemptAt: t, createdAt: t, sentAt: null });
    return ref.id;
  }

  async function compose(to, kind, subject, paragraphs, link) {
    const s = await settings.get();
    const text = paragraphs.join('\n\n') + (link ? `\n\n${link.label} : ${link.url}` : '') + `\n\n— ${s.shop_name}`;
    const html = layout(s.shop_name, subject,
      paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') +
      (link ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#2340e6;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(link.label)}</a></p>` : ''),
      cfg.appUrl);
    return queue({ to, subject: `${subject} — ${s.shop_name}`, text, html, kind });
  }

  async function processQueue(limit = 20) {
    const due = (await col.where('status', '==', 'queued').get()).docs
      .map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.nextAttemptAt <= now()).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    for (const m of due) {
      const ref = col.doc(m.id);
      if (!transport) { await ref.update({ attempts: m.attempts + 1, lastError: 'SMTP non configuré (SMTP_URL absent)', nextAttemptAt: now() + 300 }); continue; }
      try {
        await transport.sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text, html: m.html || undefined });
        await ref.update({ status: 'sent', attempts: m.attempts + 1, sentAt: now(), lastError: null });
      } catch (e) {
        const attempts = m.attempts + 1;
        await ref.update({ status: attempts >= 6 ? 'failed' : 'queued', attempts, lastError: String(e.message).slice(0, 500), nextAttemptAt: now() + 60 * 2 ** attempts });
      }
    }
  }

  const T = {
    verify(user, url) { return compose(user.email, 'verify', 'Confirmez votre adresse e-mail', [`Bonjour ${user.name},`, 'Merci pour votre inscription. Confirmez votre adresse e-mail pour pouvoir commander. Ce lien est valable 24 heures.'], { label: 'Confirmer mon adresse', url }); },
    reset(user, url) { return compose(user.email, 'reset', 'Réinitialisation du mot de passe', [`Bonjour ${user.name},`, "Une réinitialisation de mot de passe a été demandée pour votre compte. Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."], { label: 'Choisir un nouveau mot de passe', url }); },
    orderPaid(order) {
      const lines = order.items.map((i) => `• ${i.product_name}${i.variant_name ? ' — ' + i.variant_name : ''} × ${i.qty} : ${euros(i.line_total_cents)}`).join('\n');
      return compose(order.email, 'order_paid', `Commande ${order.number} confirmée`, ['Merci ! Votre paiement a bien été reçu.', lines,
        `Total payé : ${euros(order.total_cents)}` + (order.shipping_method ? `\nMode de livraison : ${order.shipping_method}` : '')],
      { label: 'Suivre ma commande', url: `${cfg.appUrl}/#commande-${order.number}` });
    },
    orderStatus(order, label, extra) { return compose(order.email, 'order_status', `Commande ${order.number} : ${label}`, [`Le statut de votre commande est maintenant : ${label}.`, ...(extra ? [extra] : [])], { label: 'Voir ma commande', url: `${cfg.appUrl}/#commande-${order.number}` }); },
    refund(order, amount, full) { return compose(order.email, 'refund', `Remboursement — commande ${order.number}`, [`Un remboursement ${full ? 'complet' : 'partiel'} de ${euros(amount)} a été émis sur votre moyen de paiement. Le délai d'apparition dépend de votre banque.`], { label: 'Voir ma commande', url: `${cfg.appUrl}/#commande-${order.number}` }); },
    outOfStockRefund(order) { return compose(order.email, 'oos_refund', `Commande ${order.number} annulée et remboursée`, ["Votre paiement est arrivé après l'expiration de la réservation de 15 minutes et un article n'était plus disponible. La commande a été annulée et intégralement remboursée."]); },
    addressChanged(order) { return compose(order.email, 'address', `Adresse modifiée — commande ${order.number}`, [`La nouvelle adresse de livraison est : ${order.ship_name}, ${order.ship_line1}${order.ship_line2 ? ', ' + order.ship_line2 : ''}, ${order.ship_postal} ${order.ship_city}.`]); },
    customQuoted(user, r) { return compose(user.email, 'custom_quote', `Devis pour « ${r.title} »`, [`Votre demande sur mesure a reçu un devis de ${euros(r.quote_cents)} (délai estimé : ${r.quote_days} jour(s)).`, ...(r.quote_message ? [r.quote_message] : []), 'Vous pouvez accepter et payer le devis depuis votre compte.'], { label: 'Voir le devis', url: `${cfg.appUrl}/#compte` }); },
    customRejected(user, r) { return compose(user.email, 'custom_rejected', `Demande « ${r.title} »`, ['Nous ne pouvons malheureusement pas réaliser cette demande.', ...(r.quote_message ? [r.quote_message] : [])]); },
    newsletterConfirm(email, url) { return compose(email, 'nl_confirm', 'Confirmez votre inscription à la newsletter', ['Cliquez sur le bouton pour confirmer votre inscription. Sans confirmation, vous ne recevrez aucun message.'], { label: "Confirmer l'inscription", url }); },
    premiumChanged(user, active) { return compose(user.email, 'premium', active ? 'Bienvenue dans Premium' : 'Abonnement Premium terminé', [active ? 'Votre abonnement Premium est actif. Vos avantages s’appliquent automatiquement à vos prochaines commandes.' : 'Votre abonnement Premium a pris fin.']); },
    adminNotify(subject, text) { return cfg.adminNotifyEmail ? compose(cfg.adminNotifyEmail, 'admin', subject, [text], { label: 'Ouvrir l’administration', url: `${cfg.appUrl}/admin` }) : null; },
  };

  return { queue, compose, processQueue, T, hasTransport: !!transport, layout };
}

module.exports = { makeMailer };
