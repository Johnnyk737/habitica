import nconf from 'nconf';
import moment from 'moment';

import logger from '../../logger';
import { model as User } from '../../../models/user'; // eslint-disable-line import/no-cycle
import { getStripeApi } from './api';
import {
  BadRequest,
  NotFound,
} from '../../errors';
import payments from '../payments'; // eslint-disable-line import/no-cycle
import { // eslint-disable-line import/no-cycle
  model as Group,
  basicFields as basicGroupFields,
} from '../../../models/group';
import shared from '../../../../common';
import { applyGemPayment } from './oneTimePayments'; // eslint-disable-line import/no-cycle
import { applySubscription } from './subscriptions'; // eslint-disable-line import/no-cycle

const endpointSecret = nconf.get('STRIPE_WEBHOOKS_ENDPOINT_SECRET');

export async function handleWebhooks (options, stripeInc) {
  const { body, headers } = options;

  // @TODO: We need to mock this, but curently we don't have correct
  // Dependency Injection. And the Stripe Api doesn't seem to be a singleton?
  let stripeApi = getStripeApi();
  if (stripeInc) stripeApi = stripeInc;

  //TODO better error handling, for each webhook error log event and affected userId

  let event;

  try {
    // Verify the event by fetching it from Stripe
    event = stripeApi.webhooks.constructEvent(body, headers['stripe-signature'], endpointSecret);
  } catch (err) {
    logger.error(new Error('Error handling Stripe webhook'), { event, err });
    throw new BadRequest(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.created':
    case 'payment_intent.succeeded':
    case 'charge.succeeded':
    case 'payment_method.attached':
    case 'customer.created':
    case 'customer.updated':
    case 'customer.deleted':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'invoice.created':
    case 'invoice.updated':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      // Events sent even if not active in the Stripe dashboard when a payment is being made
      // This is to avoid error logs from the webhook handler not being implemented
      break;
    }
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { metadata } = session;

      if (metadata.type !== 'subscription') {
        await applyGemPayment(session);
      } else {
        await applySubscription(session);
      }

      break;
    }
    case 'customer.subscription.deleted': {
      // event.request !== null means that the user itself cancelled the subscrioption,
      // the cancellation on our side has been already handled
      if (event.request !== null) break;

      const subscription = event.data.object;
      const customerId = subscription.customer;
      const isGroupSub = shared.content.subscriptionBlocks[subscription.plan.id].target === 'group';

      let user;
      let groupId;

      if (isGroupSub) {
        const groupFields = basicGroupFields.concat(' purchased');
        const group = await Group.findOne({
          'purchased.plan.customerId': customerId,
          'purchased.plan.paymentMethod': this.constants.PAYMENT_METHOD,
        }).select(groupFields).exec();

        if (!group) throw new NotFound(shared.i18n.t('groupNotFound'));
        groupId = group._id;

        user = await User.findById(group.leader).exec();
      } else {
        user = await User.findOne({
          'purchased.plan.customerId': customerId,
          'purchased.plan.paymentMethod': this.constants.PAYMENT_METHOD,
        }).exec();
      }

      if (!user) throw new NotFound(shared.i18n.t('userNotFound'));

      await stripeApi.customers.del(customerId);

      await payments.cancelSubscription({
        user,
        groupId,
        paymentMethod: this.constants.PAYMENT_METHOD,
        // Give three extra days to allow the user to resubscribe without losing benefits
        nextBill: moment().add({ days: 3 }).toDate(),
      });

      break;
    }
    default: {
      logger.error(new Error(`Missing handler for Stripe webhook ${event.type}`));
    }
  }
}
